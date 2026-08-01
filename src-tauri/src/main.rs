#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{env, fs, fs::OpenOptions, io::{Read, Write}, net::{SocketAddr, TcpStream}, path::{Path, PathBuf}, process::Command, time::Duration};
use base64::Engine;

#[derive(Serialize)]
struct AlibabaWanVideoResult {
  task_id: String,
  request_id: Option<String>,
  video_url: String,
}

#[derive(Serialize)]
struct ComfyStatus { connected: bool, endpoint: String, detail: String }

#[tauri::command]
async fn discover_api_models(endpoint: String, api_key: String) -> Result<Vec<String>, String> {
  let base = endpoint.trim().trim_end_matches('/');
  if base.is_empty() { return Err("请先填写接口地址".into()); }
  let url = if base.ends_with("/models") { base.to_string() } else { format!("{base}/models") };
  let client = reqwest::Client::builder().timeout(Duration::from_secs(25)).build().map_err(|e| e.to_string())?;
  let mut request = client.get(&url);
  if !api_key.trim().is_empty() { request = request.bearer_auth(api_key.trim()); }
  let response = request.send().await.map_err(|e| format!("无法连接模型接口：{e}"))?;
  let status = response.status();
  let value: serde_json::Value = response.json().await.map_err(|e| format!("模型接口返回的不是 JSON：{e}"))?;
  if !status.is_success() { return Err(format!("模型接口返回 {status}：{}", value.get("error").unwrap_or(&value))); }
  let list = value.get("data").and_then(|v| v.as_array()).or_else(|| value.get("models").and_then(|v| v.as_array())).ok_or("响应中没有 data/models 模型列表")?;
  let mut models: Vec<String> = list.iter().filter_map(|item| item.get("id").and_then(|v| v.as_str()).or_else(|| item.get("name").and_then(|v| v.as_str()))).map(str::to_string).collect();
  models.sort(); models.dedup();
  if models.is_empty() { return Err("接口返回了空模型列表".into()); }
  Ok(models)
}

fn comfy_reachable(port: u16) -> bool {
  let address: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
  let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(650)) else { return false; };
  let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(900)));
  if stream.write_all(b"GET /system_stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() { return false; }
  let mut response = [0u8; 512];
  let Ok(length) = stream.read(&mut response) else { return false; };
  let text = String::from_utf8_lossy(&response[..length]);
  text.starts_with("HTTP/1.1 200")
}

fn usable_ffmpeg(path: &Path) -> bool {
  Command::new(path)
    .arg("-version")
    .output()
    .map(|output| output.status.success())
    .unwrap_or(false)
}

fn find_ffmpeg() -> Result<PathBuf, String> {
  let mut candidates: Vec<PathBuf> = Vec::new();
  if let Ok(configured) = env::var("YM_FFMPEG_PATH") {
    candidates.push(PathBuf::from(configured));
  }
  if let Ok(executable) = env::current_exe() {
    if let Some(folder) = executable.parent() {
      candidates.push(folder.join("ffmpeg.exe"));
      candidates.push(folder.join("resources").join("ffmpeg.exe"));
    }
  }
  candidates.push(PathBuf::from("ffmpeg"));
  candidates.into_iter().find(|path| usable_ffmpeg(path)).ok_or_else(|| {
    "未找到 FFmpeg。请将 ffmpeg.exe 放到亿幕画布程序旁，或设置环境变量 YM_FFMPEG_PATH。".into()
  })
}

#[tauri::command]
fn ffmpeg_available() -> Result<String, String> {
  find_ffmpeg().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn transcode_webm(input_path: String, output_path: String, format: String, fps: u32) -> Result<(), String> {
  let ffmpeg = find_ffmpeg()?;
  let container = match format.as_str() {
    "mp4" => "mp4",
    "mov" => "mov",
    _ => return Err("仅支持导出 MP4 或 MOV。".into()),
  };
  let safe_fps = fps.clamp(12, 60).to_string();
  let args = vec![
    "-y".to_string(), "-i".to_string(), input_path.clone(),
    "-map".to_string(), "0:v:0".to_string(), "-map".to_string(), "0:a?".to_string(),
    "-r".to_string(), safe_fps,
    "-c:v".to_string(), "libx264".to_string(), "-pix_fmt".to_string(), "yuv420p".to_string(),
    "-c:a".to_string(), "aac".to_string(), "-movflags".to_string(), "+faststart".to_string(),
    "-f".to_string(), container.to_string(), output_path.clone(),
  ];
  let output = Command::new(ffmpeg)
    .args(args)
    .output()
    .map_err(|error| format!("启动 FFmpeg 失败：{error}"))?;
  if !output.status.success() {
    let detail = String::from_utf8_lossy(&output.stderr);
    return Err(format!("FFmpeg 转码失败：{}", detail.trim()));
  }
  let _ = fs::remove_file(input_path);
  Ok(())
}

#[tauri::command]
fn find_comfyui() -> ComfyStatus {
  for port in [8188, 8189] {
    if comfy_reachable(port) { return ComfyStatus { connected: true, endpoint: format!("http://127.0.0.1:{port}"), detail: "已验证并连接到 ComfyUI".into() }; }
  }
  let known = [r"D:\ComfyUI-aki-v2\ComfyUI", r"D:\ComfyUI\ComfyUI", r"C:\ComfyUI\ComfyUI"];
  if let Some(path) = known.iter().find(|path| Path::new(path).exists()) {
    return ComfyStatus { connected: false, endpoint: "".into(), detail: format!("已找到 ComfyUI：{path}，请先在启动器中启动它") };
  }
  ComfyStatus { connected: false, endpoint: "".into(), detail: "没有找到正在运行的 ComfyUI；请先用启动器启动 ComfyUI".into() }
}

#[tauri::command]
async fn queue_comfyui(endpoint: String, workflow: serde_json::Value) -> Result<serde_json::Value, String> {
  let url = format!("{}/prompt", endpoint.trim_end_matches('/'));
  // 兼容从 ComfyUI 导出的 { prompt: {...} } API 文件；接口需要的只能是内层节点图。
  let prompt = workflow.get("prompt").filter(|value| value.is_object()).cloned().unwrap_or(workflow);
  reqwest::Client::new().post(url).json(&serde_json::json!({"prompt": prompt, "client_id": format!("offline-canvas-{}", std::process::id())})).send().await
    .map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn interrupt_comfyui(endpoint: String) -> Result<(), String> {
  let url = format!("{}/interrupt", endpoint.trim_end_matches('/'));
  reqwest::Client::new().post(url).send().await
    .map_err(|e| e.to_string())?
    .error_for_status().map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
async fn get_comfy_object_info(endpoint: String) -> Result<serde_json::Value, String> {
  let url = format!("{}/object_info", endpoint.trim_end_matches('/'));
  reqwest::Client::new().get(url).send().await
    .map_err(|error| error.to_string())?
    .error_for_status().map_err(|error| error.to_string())?
    .json().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn generate_openai_text(
  endpoint: String,
  api_key: String,
  prompt: String,
  model: String,
  system_prompt: String,
  temperature: f64,
) -> Result<String, String> {
  let base = endpoint.trim_end_matches('/');
  let url = if base.ends_with("/v1") { format!("{base}/chat/completions") } else { format!("{base}/v1/chat/completions") };
  let response: serde_json::Value = reqwest::Client::new()
    .post(url)
    .bearer_auth(api_key)
    .json(&serde_json::json!({
      "model": model,
      "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt}
      ],
      "temperature": temperature
    }))
    .send().await.map_err(|e| e.to_string())?
    .error_for_status().map_err(|e| e.to_string())?
    .json().await.map_err(|e| e.to_string())?;
  response.pointer("/choices/0/message/content")
    .and_then(serde_json::Value::as_str)
    .map(str::to_owned)
    .ok_or_else(|| "文本模型没有返回有效内容".into())
}

#[tauri::command]
async fn describe_openai_image(
  endpoint: String,
  api_key: String,
  model: String,
  image_data: String,
) -> Result<String, String> {
  let base = endpoint.trim_end_matches('/');
  let url = if base.ends_with("/v1") { format!("{base}/chat/completions") } else { format!("{base}/v1/chat/completions") };
  let response: serde_json::Value = reqwest::Client::new()
    .post(url)
    .bearer_auth(api_key)
    .json(&serde_json::json!({
      "model": model,
      "messages": [{
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "请分析这张图片，为影视剧本创作提供可直接使用的中文素材。按以下格式简洁输出：人物（年龄感、外貌、发型、服装、表情、动作、人物关系）；场景（地点、时代、陈设、天气、时间）；视觉氛围（光线、色彩、情绪）；可用剧情线索。不要猜测具体真实身份，不要解释分析过程。"
          },
          {"type": "image_url", "image_url": {"url": image_data}}
        ]
      }],
      "temperature": 0.25
    }))
    .send().await.map_err(|e| e.to_string())?
    .error_for_status().map_err(|e| e.to_string())?
    .json().await.map_err(|e| e.to_string())?;
  response.pointer("/choices/0/message/content")
    .and_then(serde_json::Value::as_str)
    .map(str::to_owned)
    .ok_or_else(|| "视觉模型没有返回有效的图片描述".into())
}

#[tauri::command]
async fn generate_openai_image(endpoint: String, api_key: String, prompt: String, model: String) -> Result<String, String> {
  let base = endpoint.trim_end_matches('/');
  let url = if base.ends_with("/v1") { format!("{base}/images/generations") } else { format!("{base}/v1/images/generations") };
  let response: serde_json::Value = reqwest::Client::new()
    .post(url)
    .bearer_auth(api_key)
    .json(&serde_json::json!({"model": model, "prompt": prompt, "n": 1, "size": "1024x1024", "quality": "low"}))
    .send().await.map_err(|e| e.to_string())?
    .error_for_status().map_err(|e| e.to_string())?
    .json().await.map_err(|e| e.to_string())?;
  if let Some(encoded) = response.pointer("/data/0/b64_json").and_then(serde_json::Value::as_str) {
    return Ok(format!("data:image/png;base64,{encoded}"));
  }
  if let Some(url) = response.pointer("/data/0/url").and_then(serde_json::Value::as_str) {
    let bytes = reqwest::get(url).await.map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    return Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
  }
  Err("OpenAI 没有返回图片数据".into())
}

#[tauri::command]
async fn generate_openai_image_edit(
  endpoint: String,
  api_key: String,
  prompt: String,
  model: String,
  image_data: String,
) -> Result<String, String> {
  let (header, encoded) = image_data.split_once(',').ok_or_else(|| "参考图不是有效的 Data URL".to_string())?;
  let mime = header.strip_prefix("data:").and_then(|value| value.split(';').next()).unwrap_or("image/png");
  let extension = match mime {
    "image/jpeg" => "jpg",
    "image/webp" => "webp",
    _ => "png",
  };
  let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|error| error.to_string())?;
  let image_part = reqwest::multipart::Part::bytes(bytes)
    .file_name(format!("reference.{extension}"))
    .mime_str(mime)
    .map_err(|error| error.to_string())?;
  let form = reqwest::multipart::Form::new()
    .text("model", model)
    .text("prompt", prompt)
    .text("size", "1024x1024")
    .part("image", image_part);
  let base = endpoint.trim_end_matches('/');
  let url = if base.ends_with("/v1") { format!("{base}/images/edits") } else { format!("{base}/v1/images/edits") };
  let response: serde_json::Value = reqwest::Client::new()
    .post(url)
    .bearer_auth(api_key)
    .multipart(form)
    .send().await.map_err(|error| error.to_string())?
    .error_for_status().map_err(|error| error.to_string())?
    .json().await.map_err(|error| error.to_string())?;
  if let Some(encoded) = response.pointer("/data/0/b64_json").and_then(serde_json::Value::as_str) {
    return Ok(format!("data:image/png;base64,{encoded}"));
  }
  if let Some(url) = response.pointer("/data/0/url").and_then(serde_json::Value::as_str) {
    let bytes = reqwest::get(url).await.map_err(|error| error.to_string())?.bytes().await.map_err(|error| error.to_string())?;
    return Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
  }
  Err("图生图接口没有返回图片数据".into())
}

// 阿里云百炼（DashScope）万相视频采用异步任务协议：先创建任务，再查询任务状态。
// 放在 Rust 侧调用可以绕过 WebView 的跨域限制，同时 API Key 不会暴露到前端日志中。
#[tauri::command]
async fn generate_alibaba_wan_video(
  endpoint: String,
  api_key: String,
  prompt: String,
  model: String,
  ratio: String,
  quality: String,
  duration: u32,
  audio: bool,
  image_url: Option<String>,
) -> Result<AlibabaWanVideoResult, String> {
  let endpoint = endpoint.trim_end_matches('/');
  let base = if endpoint.ends_with("/api/v1") {
    endpoint.to_string()
  } else {
    format!("{endpoint}/api/v1")
  };
  let size = match (ratio.as_str(), quality.as_str()) {
    ("9:16", "480P") => "480*832",
    ("9:16", "1080P") => "1080*1920",
    ("9:16", _) => "720*1280",
    ("1:1", _) => "960*960",
    ("4:3", _) => "960*720",
    ("3:4", _) => "720*960",
    ("21:9", _) => "1472*624",
    (_, "480P") => "832*480",
    (_, "1080P") => "1920*1080",
    _ => "1280*720",
  };
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(45))
    .build()
    .map_err(|error| format!("创建网络请求失败：{error}"))?;
  let create_url = format!("{base}/services/aigc/video-generation/video-synthesis");
  let payload = if let Some(img_url) = image_url.filter(|value| !value.trim().is_empty()) {
    serde_json::json!({
      "model": model,
      "input": { "prompt": prompt, "img_url": img_url },
      "parameters": {
        "resolution": quality,
        "duration": duration.clamp(5, 10),
        "audio": audio,
        "prompt_extend": true
      }
    })
  } else {
    serde_json::json!({
      "model": model,
      "input": { "prompt": prompt },
      "parameters": {
        "size": size,
        "duration": duration.clamp(5, 10),
        "audio": audio,
        "prompt_extend": true
      }
    })
  };
  let response = client
    .post(create_url)
    .bearer_auth(&api_key)
    .header("X-DashScope-Async", "enable")
    .json(&payload)
    .send().await.map_err(|error| format!("无法连接阿里百炼：{error}"))?;
  let status = response.status();
  let created: serde_json::Value = response.json().await.map_err(|error| format!("无法读取阿里百炼响应：{error}"))?;
  if !status.is_success() {
    let message = created.pointer("/message").and_then(serde_json::Value::as_str).unwrap_or("请求被平台拒绝");
    let code = created.pointer("/code").and_then(serde_json::Value::as_str).unwrap_or("HTTP_ERROR");
    return Err(format!("阿里百炼创建任务失败（{code}）：{message}"));
  }
  let task_id = created.pointer("/output/task_id").and_then(serde_json::Value::as_str)
    .ok_or_else(|| format!("阿里百炼没有返回任务编号：{created}"))?.to_string();
  let request_id = created.pointer("/request_id").and_then(serde_json::Value::as_str).map(str::to_string);
  let poll_url = format!("{base}/tasks/{task_id}");
  for _ in 0..240 {
    tokio::time::sleep(Duration::from_secs(3)).await;
    let response = client.get(&poll_url).bearer_auth(&api_key).send().await
      .map_err(|error| format!("查询阿里百炼任务失败：{error}"))?;
    let poll_status = response.status();
    let task: serde_json::Value = response.json().await.map_err(|error| format!("无法读取阿里百炼任务状态：{error}"))?;
    if !poll_status.is_success() {
      let message = task.pointer("/message").and_then(serde_json::Value::as_str).unwrap_or("查询任务被平台拒绝");
      return Err(format!("阿里百炼查询任务失败：{message}"));
    }
    let task_status = task.pointer("/output/task_status").and_then(serde_json::Value::as_str).unwrap_or("");
    if task_status == "SUCCEEDED" {
      let video_url = task.pointer("/output/video_url").and_then(serde_json::Value::as_str)
        .or_else(|| task.pointer("/output/video_urls/0").and_then(serde_json::Value::as_str))
        .ok_or_else(|| format!("任务已完成但没有返回视频地址：{task}"))?.to_string();
      return Ok(AlibabaWanVideoResult { task_id, request_id, video_url });
    }
    if matches!(task_status, "FAILED" | "CANCELED" | "CANCELLED") {
      let message = task.pointer("/output/message").and_then(serde_json::Value::as_str)
        .or_else(|| task.pointer("/message").and_then(serde_json::Value::as_str))
        .unwrap_or("平台未提供失败原因");
      return Err(format!("阿里百炼任务{task_status}：{message}"));
    }
  }
  Err("阿里百炼任务等待超时（12 分钟），请在百炼控制台查看任务状态".into())
}

// Qwen is used only for prompt editing. The video key stays on the Rust side
// and the renderer receives only the rewritten text.
#[tauri::command]
async fn rewrite_alibaba_prompt(endpoint: String, api_key: String, prompt: String, action: String) -> Result<String, String> {
  if prompt.trim().is_empty() { return Err("提示词不能为空".into()); }
  let trimmed = endpoint.trim_end_matches('/');
  let root = trimmed.strip_suffix("/api/v1").unwrap_or(trimmed);
  let url = format!("{root}/compatible-mode/v1/chat/completions");
  let instruction = if action == "translate" {
    "Translate the user's Chinese video prompt into concise, natural English for a video generation model. Preserve every requested subject, action, composition, camera movement, style and constraint. Return only the English prompt, no explanation."
  } else {
    "Rewrite the user's video prompt into one concise, production-ready Chinese video-generation prompt. Preserve all requested facts. Clarify subject, action, scene, lighting, composition and camera movement only when implied; do not invent named people, brands or story facts. Return only the optimized prompt, no explanation."
  };
  let client = reqwest::Client::builder().timeout(Duration::from_secs(50)).build().map_err(|e| format!("无法创建提示词请求：{e}"))?;
  let response = client.post(url).bearer_auth(api_key).json(&serde_json::json!({
    "model": "qwen-plus",
    "messages": [
      {"role": "system", "content": instruction},
      {"role": "user", "content": prompt}
    ],
    "temperature": 0.3
  })).send().await.map_err(|e| format!("无法连接阿里百炼：{e}"))?;
  let status = response.status();
  let body: serde_json::Value = response.json().await.map_err(|e| format!("无法读取阿里百炼响应：{e}"))?;
  if !status.is_success() {
    let message = body.pointer("/error/message").and_then(serde_json::Value::as_str)
      .or_else(|| body.pointer("/message").and_then(serde_json::Value::as_str)).unwrap_or("平台拒绝了请求");
    return Err(format!("阿里百炼提示词服务失败：{message}"));
  }
  body.pointer("/choices/0/message/content").and_then(serde_json::Value::as_str)
    .map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
    .ok_or_else(|| format!("阿里百炼没有返回可用文本：{body}"))
}

#[tauri::command]
async fn upload_comfy_media(endpoint: String, filename: String, data_url: Option<String>, local_path: Option<String>) -> Result<String, String> {
  let bytes = if let Some(path) = local_path {
    let output = Path::new(r"D:\ComfyUI-aki-v2\ComfyUI\output");
    let source = Path::new(&path);
    if !source.starts_with(output) { return Err("只允许复用 ComfyUI 输出目录内的素材".into()); }
    fs::read(source).map_err(|e| e.to_string())?
  } else if let Some(data) = data_url {
    let encoded = data.split_once(",").map(|(_, body)| body).ok_or("媒体数据格式不正确")?;
    base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| e.to_string())?
  } else { return Err("没有可上传的媒体内容".into()); };
  let part = reqwest::multipart::Part::bytes(bytes).file_name(filename.clone());
  let form = reqwest::multipart::Form::new().part("image", part).text("overwrite", "true");
  let url = format!("{}/upload/image", endpoint.trim_end_matches('/'));
  let response: serde_json::Value = reqwest::Client::new().post(url).multipart(form).send().await.map_err(|e| e.to_string())?
    .error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
  let name = response.get("name").and_then(serde_json::Value::as_str).unwrap_or(&filename);
  let subfolder = response.get("subfolder").and_then(serde_json::Value::as_str).unwrap_or("");
  Ok(if subfolder.is_empty() { name.to_string() } else { format!("{subfolder}/{name}") })
}

#[tauri::command]
async fn get_comfy_history(endpoint: String, prompt_id: String) -> Result<serde_json::Value, String> {
  let url = format!("{}/history/{}", endpoint.trim_end_matches('/'), prompt_id);
  let mut history: serde_json::Value = reqwest::Client::new().get(url).send().await.map_err(|e| e.to_string())?
    .error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
  if let Some(entries) = history.as_object_mut() {
    for entry in entries.values_mut() {
      if let Some(outputs) = entry.get_mut("outputs").and_then(serde_json::Value::as_object_mut) {
        for output in outputs.values_mut() {
          for key in ["images", "gifs"] {
            if let Some(files) = output.get_mut(key).and_then(serde_json::Value::as_array_mut) {
              for file in files {
                if file.get("fullpath").is_none() {
                  let filename = file.get("filename").and_then(serde_json::Value::as_str).unwrap_or("");
                  let subfolder = file.get("subfolder").and_then(serde_json::Value::as_str).unwrap_or("");
                  if !filename.is_empty() && !filename.contains("..") && !subfolder.contains("..") {
                    let path = if subfolder.is_empty() { format!(r"D:\ComfyUI-aki-v2\ComfyUI\output\{}", filename) } else { format!(r"D:\ComfyUI-aki-v2\ComfyUI\output\{}\{}", subfolder, filename) };
                    if let Some(object) = file.as_object_mut() { object.insert("fullpath".into(), serde_json::Value::String(path)); }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  Ok(history)
}

#[tauri::command]
fn save_project(path: String, content: String) -> Result<(), String> {
  fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_media(path: String, source_path: Option<String>, data_url: Option<String>) -> Result<(), String> {
  if let Some(source) = source_path {
    fs::copy(source, path).map_err(|e| e.to_string())?;
    return Ok(());
  }
  if let Some(data) = data_url {
    let encoded = data.split_once(',').map(|(_, body)| body).ok_or("媒体数据格式不正确")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())?;
    return Ok(());
  }
  Err("没有可保存的媒体内容".into())
}

// Director export can be tens or hundreds of MB.  Writing it in chunks avoids
// exhausting the WebView/Tauri IPC payload limit before FFmpeg gets a chance
// to perform the final MP4/MOV transcode.
#[tauri::command]
fn write_export_chunk(path: String, data: String, append: bool) -> Result<(), String> {
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(data.as_bytes())
    .map_err(|error| format!("导出数据解码失败：{error}"))?;
  let mut options = OpenOptions::new();
  options.write(true).create(true);
  if append {
    options.append(true);
  } else {
    options.truncate(true);
  }
  let mut file = options.open(&path).map_err(|error| format!("无法创建临时视频：{error}"))?;
  file.write_all(&bytes).map_err(|error| format!("写入临时视频失败：{error}"))?;
  Ok(())
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![discover_api_models, find_comfyui, queue_comfyui, interrupt_comfyui, get_comfy_object_info, generate_openai_text, describe_openai_image, generate_openai_image_edit, generate_openai_image, generate_alibaba_wan_video, rewrite_alibaba_prompt, upload_comfy_media, get_comfy_history, save_project, save_media, write_export_chunk, ffmpeg_available, transcode_webm])
    .run(tauri::generate_context!())
    .expect("启动离线画布失败");
}
