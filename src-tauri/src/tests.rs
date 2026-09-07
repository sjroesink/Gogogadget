use crate::{
    http::{http_cancel, http_request, Http},
    process::{process_close, process_open, process_write, Processes, WireEvent},
};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    Manager,
};

fn capture() -> (
    Channel<WireEvent>,
    tokio::sync::mpsc::UnboundedReceiver<Value>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(text) = body {
            let _ = tx.send(serde_json::from_str(&text).unwrap());
        }
        Ok(())
    });
    (channel, rx)
}

#[tokio::test]
async fn native_process_roundtrip_and_awaited_shutdown() {
    let app = tauri::test::mock_app();
    app.manage(Processes::default());
    let (events, mut rx) = capture();
    let script =
        "process.stdin.on('data',data=>process.stdout.write(data)); setInterval(()=>{},1000);";
    process_open(
        app.state(),
        "test".into(),
        "node".into(),
        vec!["-e".into(), script.into()],
        "".into(),
        events,
    )
    .await
    .unwrap();
    process_write(app.state(), "test".into(), "{\"text\":\"hé🙂\"}".into())
        .await
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["type"], "line");
    assert!(event["data"].as_str().unwrap().contains("hé🙂"));
    process_close(app.state(), "test".into()).await.unwrap();
    assert!(process_write(app.state(), "test".into(), "{}".into())
        .await
        .is_err());
    let exit = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(exit["type"], "exit");
}

#[tokio::test]
async fn native_process_rejects_unbounded_frames_and_handles_stderr() {
    let app = tauri::test::mock_app();
    app.manage(Processes::default());
    let (events, mut rx) = capture();
    let script = "process.stderr.write('x'.repeat(100000)); process.stdout.write('x'.repeat(5*1024*1024)); setInterval(()=>{},1000);";
    process_open(
        app.state(),
        "limit".into(),
        "node".into(),
        vec!["-e".into(), script.into()],
        "".into(),
        events,
    )
    .await
    .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["type"], "error");
    assert_eq!(event["data"], "Agent message too large");
    process_close(app.state(), "limit".into()).await.unwrap();
}

#[tokio::test]
async fn native_http_preserves_split_utf8_frames_and_trailing_line() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut input = [0u8; 8192];
        let _ = stream.read(&mut input);
        let body = "{\"message\":{\"content\":\"hé🙂\"}}\n{\"done\":true}".as_bytes();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        for byte in body {
            stream.write_all(&[*byte]).unwrap();
        }
    });
    let app = tauri::test::mock_app();
    app.manage(Http::default());
    let (events, mut rx) = capture();
    http_request(
        app.state(),
        "http".into(),
        format!("http://{addr}"),
        "/api/chat".into(),
        Some(json!({})),
        events,
    )
    .await
    .unwrap();
    let first = rx.recv().await.unwrap();
    assert_eq!(first["type"], "ready");
    let first = rx.recv().await.unwrap();
    assert!(first["data"].as_str().unwrap().contains("hé🙂"));
    let last = rx.recv().await.unwrap();
    assert_eq!(last["data"], "{\"done\":true}");
    server.join().unwrap();
}

#[tokio::test]
async fn native_http_cancels_a_stalled_response() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut input = [0u8; 8192];
        let _ = stream.read(&mut input);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n")
            .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let _ = stream.read(&mut input);
    });
    let app = tauri::test::mock_app();
    app.manage(Http::default());
    let (events, _) = capture();
    let request = http_request(
        app.state(),
        "cancel".into(),
        format!("http://{addr}"),
        "/api/chat".into(),
        Some(json!({})),
        events,
    );
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        http_cancel(app.state(), "cancel".into()).await.unwrap();
    };
    let (result, _) = tokio::join!(request, cancel);
    assert_eq!(result.unwrap_err(), "Cancelled");
    server.join().unwrap();
}

#[tokio::test]
#[ignore = "requires Codex; starts an ephemeral thread; inference only with GOGOGADGET_LIVE_COMPLETION=1"]
async fn installed_codex_handshake_and_models() {
    let app = tauri::test::mock_app();
    app.manage(Processes::default());
    let (events, mut rx) = capture();
    process_open(
        app.state(),
        "codex-live".into(),
        "codex".into(),
        vec!["app-server".into()],
        "".into(),
        events,
    )
    .await
    .unwrap();
    process_write(app.state(), "codex-live".into(), json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"gogogadget_test","version":"0.1.0"}}}).to_string()).await.unwrap();
    async fn response(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>, id: u64) -> Value {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let event = rx.recv().await.expect("process exited");
                assert_eq!(event["type"], "line", "{event}");
                let message: Value = serde_json::from_str(event["data"].as_str().unwrap()).unwrap();
                if message["id"] == id {
                    assert!(message["error"].is_null(), "{message}");
                    return message["result"].clone();
                }
            }
        })
        .await
        .unwrap()
    }
    let init = response(&mut rx, 1).await;
    assert!(init.is_object());
    process_write(
        app.state(),
        "codex-live".into(),
        json!({"method":"initialized","params":{}}).to_string(),
    )
    .await
    .unwrap();
    process_write(
        app.state(),
        "codex-live".into(),
        json!({"id":2,"method":"model/list","params":{"limit":100}}).to_string(),
    )
    .await
    .unwrap();
    let models = response(&mut rx, 2).await;
    assert!(!models["data"].as_array().unwrap().is_empty());
    println!(
        "Codex model IDs: {:?}",
        models["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["model"].as_str().unwrap())
            .collect::<Vec<_>>()
    );
    println!(
        "Codex: {} models discovered through native transport",
        models["data"].as_array().unwrap().len()
    );
    let cwd = std::env::temp_dir().join("gogogadget-protocol-test");
    std::fs::create_dir_all(&cwd).unwrap();
    let model = std::env::var("GOGOGADGET_TEST_MODEL").ok();
    if let Some(ref selected) = model {
        assert!(
            models["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["model"].as_str() == Some(selected)),
            "Test model is absent from Codex catalog"
        );
    }
    process_write(
        app.state(),
        "codex-live".into(),
        json!({"id":3,"method":"thread/start","params":{
            "model":model,"cwd":cwd,"approvalPolicy":"never","sandbox":"read-only","ephemeral":true
        }})
        .to_string(),
    )
    .await
    .unwrap();
    let thread = response(&mut rx, 3).await;
    assert!(thread["thread"]["id"].is_string());
    assert_eq!(thread["sandbox"]["type"], "readOnly"); // Response policy uses camelCase; request mode uses kebab-case.
    println!("Codex: read-only thread/start accepted");
    if std::env::var("GOGOGADGET_LIVE_COMPLETION").as_deref() == Ok("1") {
        process_write(app.state(), "codex-live".into(), json!({"id":4,"method":"turn/start","params":{
            "threadId":thread["thread"]["id"],"input":[{"type":"text","text":"Reply exactly with OK. Do not use tools."}]
        }}).to_string()).await.unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(90), async {
            let mut text = String::new();
            loop {
                let event = rx.recv().await.expect("process exited during turn");
                assert_eq!(event["type"], "line", "{event}");
                let message: Value = serde_json::from_str(event["data"].as_str().unwrap()).unwrap();
                if message["id"] == 4 {
                    assert!(message["error"].is_null(), "{message}");
                }
                if message["method"] == "item/agentMessage/delta" {
                    text.push_str(message["params"]["delta"].as_str().unwrap());
                }
                if message["method"] == "turn/completed" {
                    assert_eq!(
                        message["params"]["turn"]["status"], "completed",
                        "{message}"
                    );
                    return text;
                }
            }
        })
        .await
        .expect("completion timed out");
        assert!(!outcome.trim().is_empty());
        println!("Codex live streamed response: {outcome}");
    }
    process_close(app.state(), "codex-live".into())
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires a running local Ollama server; reads model metadata only"]
async fn installed_ollama_models() {
    let app = tauri::test::mock_app();
    app.manage(Http::default());
    let (events, mut rx) = capture();
    http_request(
        app.state(),
        "ollama-live".into(),
        "http://127.0.0.1:11434".into(),
        "/api/tags".into(),
        None,
        events,
    )
    .await
    .unwrap();
    let ready = rx.recv().await.unwrap();
    assert_eq!(ready["type"], "ready");
    let event = rx.recv().await.unwrap();
    let data: Value = serde_json::from_str(event["data"].as_str().unwrap()).unwrap();
    assert!(data["models"].is_array());
    println!(
        "Ollama: {} models discovered through native transport",
        data["models"].as_array().unwrap().len()
    );
}
