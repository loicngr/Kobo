"""Opt-in offline smoke: real PATH vibe-acp, local fake provider and MCP only."""

import json
import os
from pathlib import Path
import queue
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


records = []
provider_requests = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        provider_requests.append(body)
        recent = body["messages"][max(i for i, message in enumerate(body["messages"]) if message["role"] == "user") + 1:]
        tool_results = [message for message in recent if message["role"] == "tool"]
        turn = "resume" if "Resume" in str(body["messages"][max(i for i, message in enumerate(body["messages"]) if message["role"] == "user")]) else "new"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunks = [
            {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "Offline probe completed."}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
        ]
        steps = [
            ("write_file", {"path": str(root / (turn + "-file.txt")), "content": "native-file"}),
            ("bash", {"command": "printf native-shell > " + shlex.quote(str(root / (turn + "-shell.txt")))}),
            ("ask_user_question", {"questions": [{"question": "Choose the offline check", "options": [{"label": "One"}, {"label": "Two"}]}, {"question": "Choose multiple checks", "multiSelect": True, "options": [{"label": "One"}, {"label": "Two"}]}]}),
            ("search_tool_functions", {"query": "mcp_kobo_probe.env_probe"}),
            ("run_typescript", {"code": "async function main() { return await tools.mcp_kobo_probe.env_probe({}); }"}),
        ]
        if len(tool_results) < len(steps):
            name, arguments = steps[len(tool_results)]
            chunks = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "probe-" + str(len(provider_requests)), "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
            ]
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps({"id": "offline-probe", "object": "chat.completion.chunk", "model": "probe", **chunk}) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


MCP = '''import json, os, sys
from pathlib import Path
Path(sys.argv[1]).open("a").write(os.environ["KOBO_PROBE_TOKEN"] + "\\n")
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "kobo-probe", "version": "0"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "env_probe", "description": "Return the synthetic launch marker", "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": os.environ["KOBO_PROBE_TOKEN"]}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
'''


class Peer:
    def __init__(self, root, env):
        self.process = subprocess.Popen(
            ["vibe-acp"], cwd=root, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        self.messages = queue.Queue()
        self.error = []
        self.next_id = 0
        threading.Thread(target=self.read, daemon=True).start()
        threading.Thread(target=lambda: self.error.append(self.process.stderr.read()), daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))
        self.messages.put(None)

    def send(self, message):
        records.append({"provenance": "runtime-3.0.1", "direction": "client", "message": message})
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def request(self, method, params):
        self.next_id += 1
        request_id = self.next_id
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            message = self.messages.get(timeout=30)
            assert message is not None, self.error
            records.append({"provenance": "runtime-3.0.1", "direction": "agent", "message": message})
            if message.get("method") == "session/request_permission":
                assert any(option["optionId"] == "allow_once" for option in message["params"]["options"])
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": {"outcome": {"outcome": "selected", "optionId": "allow_once"}}})
            elif message.get("method") == "elicitation/create":
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": {"action": "accept", "content": {"q0": "One", "q1": ["One", "Two"]}}})
            elif message.get("id") == request_id:
                assert "error" not in message, message
                return message["result"]

    def close(self):
        os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=3)


with tempfile.TemporaryDirectory(prefix="kobo-vibe-protocol-") as temporary:
    root = Path(temporary)
    (root / "native").mkdir()
    mcp_path = root / "mcp.py"
    mcp_path.write_text(MCP)
    env_log = root / "mcp-launches.txt"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
    env.update({
        "VIBE_HOME": str(root / "native"),
        "VIBE_ENABLE_TELEMETRY": "false",
        "VIBE_ENABLE_UPDATE_CHECKS": "false",
        "VIBE_ENABLE_AUTO_UPDATE": "false",
        "VIBE_TEST_DISABLE_AUTO_TITLE": "1",
        "VIBE_DEFAULT_AGENT": "ask",
        "VIBE_DISABLED_SKILLS": '["*"]',
        "VIBE_ACTIVE_MODEL": "probe",
        "VIBE_PROVIDERS": json.dumps([{"name": "stub", "api_base": f"http://127.0.0.1:{server.server_port}/v1", "api_key_env_var": "", "backend": "generic"}]),
        "VIBE_MODELS": json.dumps([{"name": "probe", "alias": "probe", "provider": "stub", "thinking": "off"}]),
    })

    def mcp(marker):
        return [{"name": "kobo-probe", "command": sys.executable, "args": [str(mcp_path), str(env_log)], "env": [{"name": "KOBO_PROBE_TOKEN", "value": marker}]}]

    peer = Peer(root, env)
    try:
        initialized = peer.request("initialize", {"protocolVersion": 1, "clientCapabilities": {"elicitation": {"form": {}}}, "clientInfo": {"name": "kobo-compatibility-probe", "version": "0"}})
        assert initialized["agentInfo"]["version"] == "3.0.1"
        created = peer.request("session/new", {"cwd": str(root), "mcpServers": mcp("first-launch")})
        session = created["sessionId"]
        assert [mode["id"] for mode in created["modes"]["availableModes"]] == ["ask", "accept-edits", "auto-approve"]
        result = peer.request("session/prompt", {"sessionId": session, "prompt": [{"type": "text", "text": "Run the offline probe."}]})
        assert result["stopReason"] == "end_turn", result
    finally:
        peer.close()
    peer = Peer(root, env)
    try:
        peer.request("initialize", {"protocolVersion": 1, "clientCapabilities": {"elicitation": {"form": {}}}})
        loaded = peer.request("session/load", {"sessionId": session, "cwd": str(root), "mcpServers": mcp("second-launch")})
        result = peer.request("session/prompt", {"sessionId": session, "prompt": [{"type": "text", "text": "Resume the offline probe."}]})
        assert result["stopReason"] == "end_turn", result
        assert set(env_log.read_text().splitlines()) == {"first-launch", "second-launch"}
        for turn in ("new", "resume"):
            assert (root / (turn + "-file.txt")).read_text() == "native-file"
            assert (root / (turn + "-shell.txt")).read_text() == "native-shell"
        assert any(message.get("content") == '"second-launch"' for message in provider_requests[-1]["messages"])
        print("PASS new/load, native file/shell, permission callbacks, form questions, MCP calls with fresh env, streaming and end_turn", flush=True)
        if len(sys.argv) > 1:
            selected = [record for record in records if record["message"].get("params", {}).get("update", {}).get("sessionUpdate") != "available_commands_update"]
            output = "\n".join(json.dumps(record, separators=(",", ":")) for record in selected) + "\n"
            output = output.replace(str(root), "/tmp/kobo-acp-fixture").replace(session, "session-fixture")
            output = output.replace(sys.executable, "/usr/bin/python3")
            identifiers = {}
            output = re.sub(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", lambda match: identifiers.setdefault(match[0], f"id-{len(identifiers) + 1}"), output)
            Path(sys.argv[1]).write_text(output)
    finally:
        peer.close()
        server.shutdown()
