#!/usr/bin/env python3
"""End-to-end check of the interactive chat through a real pseudo-terminal.
A fake model asks to write hello.txt; we approve it, then undo it. Run: python3 test/e2e_chat.py"""
import json, os, pty, select, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
calls = []

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b'{"data":[]}')
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        calls.append(body)
        last = body['messages'][-1]
        if last['role'] == 'tool':
            msg = {'role': 'assistant', 'content': 'Done: ' + last['content']}
        else:
            msg = {'role': 'assistant', 'content': 'Creating the file.', 'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'write_file', 'arguments': json.dumps({'path': 'hello.txt', 'content': 'hello\n'})}}]}
        out = json.dumps({'choices': [{'message': msg, 'finish_reason': 'stop'}], 'usage': {'total_tokens': 42}}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(out)

srv = HTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

home = tempfile.mkdtemp(); proj = tempfile.mkdtemp()
s = socket_port = None
import socket
sk = socket.socket(); sk.bind(('127.0.0.1', 0)); port = sk.getsockname()[1]; sk.close()
os.makedirs(home + '/data', exist_ok=True)
json.dump({'port': port, 'defaultLane': 'edit', 'providers': {'a': {'url': f'http://127.0.0.1:{srv.server_port}', 'keyEnv': 'A_KEY'}}, 'lanes': {'edit': [['a', 'm']]}}, open(home + '/data/config.json', 'w'))
env = dict(os.environ, AG_HOME=home + '/data', HOME=home, A_KEY='k', NO_COLOR='1', TERM='xterm')

m, sl = pty.openpty()
p = subprocess.Popen(['node', ROOT + '/src/ag.js', 'chat'], stdin=sl, stdout=sl, stderr=sl, cwd=proj, env=env, close_fds=True)
buf = ''
def expect(text, timeout=15):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        if text in buf: i = buf.index(text) + len(text); r = buf[:i]; buf = buf[i:]; return r
        if select.select([m], [], [], 0.2)[0]:
            try: buf += os.read(m, 4096).decode(errors='replace')
            except OSError: break
    sys.exit(f'FAIL: never saw {text!r}\n--- got ---\n{buf}')
def send(t): os.write(m, (t + '\n').encode())

expect('[edit] ›')
send('make hello.txt')
expect('WRITE hello.txt'); expect('apply?')
send('y')
expect('applied'); expect('Done: Wrote hello.txt')
assert open(proj + '/hello.txt').read() == 'hello\n', 'file content'
expect('[edit] ›')
send('/changes'); expect('write hello.txt')
expect('[edit] ›')
send('/undo'); expect('proceed?')
send('y'); expect('restored')
assert not os.path.exists(proj + '/hello.txt'), 'undo should delete the file it created'
expect('[edit] ›')
send('/exit'); expect('session saved')
p.wait(timeout=10)
# router must have been stopped by the chat that started it
time.sleep(0.3)
try:
    import urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1); sys.exit('FAIL: router still running after exit')
except Exception: pass
assert any(c['messages'][0]['role'] == 'system' for c in calls)
print('e2e chat: OK')
