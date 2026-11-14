#!/usr/bin/env python3
"""End-to-end checks of the interactive screens through a real pseudo-terminal (Linux and macOS).

A fake model drives the chat: it asks to write and edit files, we review/approve/deny them, pin
models, compact the history, resume a session, and enter an API key at a hidden prompt.
Run: python3 test/e2e_chat.py"""
import json, os, pty, select, socket, subprocess, sys, tempfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, 'bin', 'agt.js')
calls = []


def tool_call(name, args):
    return {'role': 'assistant', 'content': 'Working.', 'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(b'{"data":[{"id":"models/zz-model"}]}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        calls.append(body)
        last = body['messages'][-1]
        text = last['content'] if last['role'] == 'user' else ''
        if 'Summarize this coding-agent session' in text: msg = {'role': 'assistant', 'content': 'SUMMARY: hello.txt and crlf.txt were handled.'}
        elif last['role'] == 'tool': msg = {'role': 'assistant', 'content': 'Done: ' + last['content']}
        elif 'make hello' in text: msg = tool_call('write_file', {'path': 'hello.txt', 'content': 'hello\n'})
        elif 'fix crlf' in text: msg = tool_call('edit_file', {'path': 'crlf.txt', 'old_str': 'two\nthree', 'new_str': 'TWO\nthree'})
        elif 'deny me' in text: msg = tool_call('write_file', {'path': 'deny.txt', 'content': 'x\n'})
        else: msg = {'role': 'assistant', 'content': 'plain reply'}
        out = json.dumps({'choices': [{'message': msg, 'finish_reason': 'stop'}], 'usage': {'total_tokens': 42}}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(out)


srv = HTTPServer(('127.0.0.1', 0), Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()

home = tempfile.mkdtemp(); proj = tempfile.mkdtemp(); data = home + '/data'
sk = socket.socket(); sk.bind(('127.0.0.1', 0)); port = sk.getsockname()[1]; sk.close()
os.makedirs(data, exist_ok=True)
json.dump({'port': port, 'defaultLane': 'edit', 'aliases': {'fast': 'a/fast-model'},
           'providers': {'a': {'url': f'http://127.0.0.1:{srv.server_port}', 'keyEnv': 'A_KEY'}},
           'lanes': {'edit': [['a', 'm']]}}, open(data + '/config.json', 'w'))
BASE_ENV = dict(os.environ, AGT_HOME=data, HOME=home, USERPROFILE=home, NO_COLOR='1', TERM='xterm', AGT_NO_UPDATE_CHECK='1')
open(proj + '/crlf.txt', 'wb').write(b'one\r\ntwo\r\nthree\r\n')


class Term:
    def __init__(self, args, env):
        self.m, sl = pty.openpty()
        self.p = subprocess.Popen(['node', CLI] + args, stdin=sl, stdout=sl, stderr=sl, cwd=proj, env=env, close_fds=True)
        self.buf = ''; self.all = ''

    def expect(self, text, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            if text in self.buf:
                i = self.buf.index(text) + len(text); r = self.buf[:i]; self.buf = self.buf[i:]; return r
            if select.select([self.m], [], [], 0.2)[0]:
                try:
                    chunk = os.read(self.m, 4096).decode(errors='replace'); self.buf += chunk; self.all += chunk
                except OSError: break
        sys.exit(f'FAIL: never saw {text!r}\n--- got ---\n{self.buf}')

    def send(self, t, end='\n'): os.write(self.m, (t + end).encode())
    def wait(self, timeout=15): return self.p.wait(timeout=timeout)


def router_running():
    try: urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1); return True
    except Exception: return False


env = dict(BASE_ENV, A_KEY='k')

# ---------- 1. chat: review options, CRLF edit, deny with a reason ----------
t = Term(['chat'], env)
t.expect('[edit] ›')
t.send('make hello.txt')
t.expect('WRITE hello.txt'); t.expect('apply?')
t.send('d'); t.expect('+hello')
t.expect('apply?'); t.send('v'); t.expect('proposed file')
t.expect('apply?'); t.send('s'); t.expect('staged copy')
assert any(f.endswith('-hello.txt') for f in os.listdir(data + '/proposed')), 'staged copy should exist'
assert not os.path.exists(proj + '/hello.txt'), 'nothing is written before approval'
t.expect('apply?'); t.send('y')
t.expect('applied'); t.expect('Done: Wrote hello.txt')
assert open(proj + '/hello.txt').read() == 'hello\n'

t.expect('[edit] ›'); t.send('fix crlf please')
t.expect('EDIT crlf.txt'); t.expect('apply?'); t.send('y'); t.expect('applied')
assert open(proj + '/crlf.txt', 'rb').read() == b'one\r\nTWO\r\nthree\r\n', 'a CRLF file must stay CRLF'

t.expect('[edit] ›'); t.send('deny me')
t.expect('WRITE deny.txt'); t.expect('apply?'); t.send('n')
t.expect('reason for the agent'); t.send('too risky')
t.expect('Done: The user denied this change. Reason: too risky')
assert not os.path.exists(proj + '/deny.txt')

# ---------- 2. pinning a model, separate from the lane ----------
t.expect('[edit] ›'); t.send('/model'); t.expect('no model pinned')
t.expect('[edit] ›'); t.send('/model nonsense/zzz'); t.expect('is not an alias, a lane or a provider/model')
t.expect('[edit] ›'); t.send('/model fast'); t.expect('model pinned: fast (a/fast-model)')
t.expect('[model: fast] ›'); t.send('hello there'); t.expect('plain reply')
assert calls[-1]['model'] == 'fast-model', calls[-1]['model']
t.expect('[model: fast] ›'); t.send('/status'); t.expect('model fast (pinned)')
t.expect('[model: fast] ›'); t.send('/models'); t.expect('fast = a/fast-model')
t.expect('[model: fast] ›'); t.send('/models live'); t.expect('a/zz-model')
t.expect('[model: fast] ›'); t.send('/model auto'); t.expect('model unpinned')
t.expect('[edit] ›'); t.send('and again'); t.expect('plain reply')
assert calls[-1]['model'] == 'm', calls[-1]['model']

# ---------- 3. compact ----------
t.expect('[edit] ›'); t.send('/compact'); t.expect('compacted:')
t.expect('[edit] ›'); t.send('after compact'); t.expect('plain reply')
assert calls[-1]['messages'][1]['content'].startswith('Summary of our work so far'), 'history was replaced by the summary'
assert any(f.endswith('.precompact.bak') for f in os.listdir(data + '/sessions')), 'full history is kept'

# ---------- 4. undo, then exit (the chat started the router, so it stops it) ----------
t.expect('[edit] ›'); t.send('/model fast'); t.expect('model pinned')
t.expect('[model: fast] ›'); t.send('/undo'); t.expect('proceed?'); t.send('y'); t.expect('restored')
t.expect('[model: fast] ›'); t.send('/exit'); t.expect('session saved'); t.wait()
time.sleep(0.3)
assert not router_running(), 'router must be stopped by the chat that started it'

# ---------- 5. resume remembers the pinned model ----------
t2 = Term(['resume'], env)
t2.expect('[model: fast] ›')
t2.send('/exit'); t2.expect('session saved'); t2.wait()

# ---------- 6. hidden key prompt: the secret is never echoed and lands in a private file ----------
kenv = dict(BASE_ENV); kenv.pop('A_KEY', None)
t3 = Term(['keys', 'set', 'a', '--no-test'], kenv)
t3.expect('A_KEY (input is hidden):')
t3.send('sk-secret-xyz', end='\r')
t3.expect('13 characters received'); t3.expect('saved A_KEY'); t3.wait()
assert 'sk-secret-xyz' not in t3.all, 'the key must not be echoed'
assert 'A_KEY="sk-secret-xyz"' in open(data + '/keys.env').read()
assert os.stat(data + '/keys.env').st_mode & 0o777 == 0o600

print('e2e chat: OK')
