/* ============================================================
   CONFIG — public page. Everything here ships to the browser.
   ============================================================ */
const CONFIG = {
  apiKey  : "sk-NMSwFveIUHqL3Q9HId5pIIYLeg5SdpoDaoOR9Asf5GW7mTCG",

  /* TokenRouter sends no CORS headers — its preflight answers 403, so a browser
     refuses the call and fetch() reports the generic "Failed to fetch". A page
     can never call it directly, whatever the host.

     So the call goes to a relay the user runs in their own terminal (relay.py,
     configured in Settings), which has no CORS to obey and holds the API key.
     Failing that, a same-origin /api path that the host rewrites server-side
     (_redirects / netlify.toml). The relay is preferred: it works on any host,
     including none, and keeps the key off the page. */
  apiPath : "/api/v1/chat/completions",
  apiHost : "https://api.tokenrouter.com",

  brain   : "moonshotai/kimi-k3-free",                            // writes and decides
  eyes    : "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", // looks and reports

  cooldown: 3,

  /* CPython 3.14 compiled to wasm. Full stdlib — os, shutil, pathlib, json,
     sqlite3, re, csv — plus pip for pure-Python wheels. Nothing to host. */
  pyodide : "https://cdn.jsdelivr.net/pyodide/v314.0.3/full/pyodide.js",
  home    : "/home/agent"
};

const SYSTEM = `You are Big Agent. You build things, and you have two partners.

EYES — a vision model. It looks at screenshots of what you build and reports back tagged [EYES]. You cannot see; trust its report over your own assumption.

MACHINE — a real CPython 3.14 interpreter in this browser tab, with the full standard library and a working filesystem. os, shutil, pathlib, json, re, csv, sqlite3, datetime all work. numpy, pandas and matplotlib load on demand if you import them. pip install works for pure-Python packages. There is no network from inside Python and no system binaries — only Python and a small shell built on top of it. Output comes back tagged [MACHINE].

Your working directory is /home/agent. Every FILE block you emit is written there before your next turn, so you can read, run and edit your own files.

Emit blocks exactly like these:

<<<FILE app.py>>>
...complete contents...
<<<END>>>

<<<PY>>>
import shutil, os
print(os.listdir("."))
<<<END>>>

<<<RUN>>>
ls -la
python app.py
<<<END>>>

<<<IMAGE hero.jpg>>>
a vivid, specific visual prompt
<<<END>>>

How the loop works: emit FILE blocks including an index.html and the page gets rendered and screenshotted, then EYES reports on it. Emit PY or RUN and the output comes straight back to you. If something is wrong, emit the corrected files in full — the whole file, never a patch. When it is right, say so plainly and stop emitting blocks; that message is what the user reads.

Rules:
- File contents must be complete and runnable. No placeholders.
- Multi-file web builds: reference styles and scripts by plain relative name (href="style.css", src="app.js") and emit each as its own FILE block.
- Never wrap a file's contents in a markdown code fence as well.
- Prefer PY over RUN for anything real. The shell is a convenience, not bash.
- Keep prose short.`;
/* ========================================================== */

const $ = s => document.querySelector(s);
const el = {
  thread:$('#thread'), inner:$('#threadInner'), q:$('#q'), send:$('#send'), stop:$('#stop'),
  status:$('#status'), config:$('#config'), count:$('#artCount'), panel:$('#panel'), left:$('#left'),
  attached:$('#attached'), pic:$('#attachedPic'), picName:$('#attachedName'), picker:$('#picker'),
  frame:$('#previewFrame'), previewSt:$('#previewSt'), term:$('#term'), machineSt:$('#machineSt'),
  files:$('#files'), filesSt:$('#filesSt'), cmd:$('#cmd')
};
let messages = [{role:'system', content:SYSTEM}];
let artifacts = [], abort = null, lastSend = 0, busy = false, pending = null;

$('#brainTag').textContent = 'brain · ' + CONFIG.brain;
$('#eyesTag').textContent  = 'eyes · ' + CONFIG.eyes.split('/').pop();
$('#toggleConfig').onclick = () => el.config.classList.toggle('open');

/* ---------- panel ---------- */
function showPanel(which){
  el.panel.classList.remove('hide');
  if(innerWidth <= 960) el.left.classList.add('dim');
  if(which) selectTab(which);
}
function hidePanel(){ el.panel.classList.add('hide'); el.left.classList.remove('dim'); }
function selectTab(name){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.pane === name));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + name));
  if(name === 'files') listFiles();
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  if(t.dataset.pane === 'close') return hidePanel();
  selectTab(t.dataset.pane);
});
$('#togglePanel').onclick = () => el.panel.classList.contains('hide') ? showPanel('preview') : hidePanel();

$('#newChat').onclick = () => {
  if(busy) return;
  messages = [{role:'system', content:SYSTEM}];
  artifacts = []; updateCount(); dropAttach();
  el.inner.innerHTML = '';
  bot('<p>Fresh start. What are we building?</p>', true);
};

/* ---------- thread ---------- */
function scroll(){ el.thread.scrollTop = el.thread.scrollHeight; }
function bubble(who, cls){
  const m = document.createElement('div');
  m.className = 'msg ' + cls;
  m.innerHTML = `<div class="who"></div><div class="body"></div>`;
  m.querySelector('.who').textContent = who;
  el.inner.appendChild(m);
  scroll();
  return m.querySelector('.body');
}
function you(text, dataUrl){
  const b = bubble('You','you');
  if(dataUrl){ const i = document.createElement('img'); i.className='userpic'; i.src=dataUrl; b.appendChild(i); }
  b.appendChild(document.createTextNode(text));
  scroll();
}
function bot(html, raw){ const b = bubble('Big Agent','bot'); b.innerHTML = raw ? html : md(html); scroll(); return b; }
function machineSays(text){
  const b = bubble('Machine','machine');
  b.textContent = (text || '').trim() || '(no output)';
  scroll();
}
function eyesSays(verdict, shotUrl){
  const b = bubble('Eyes','eyes');
  const off = /^\s*off\b/i.test(verdict);
  if(shotUrl){
    const i = document.createElement('img');
    i.className = 'shot'; i.src = shotUrl;
    i.onclick = () => window.open(shotUrl, '_blank');
    b.appendChild(i);
  }
  const s = document.createElement('div');
  s.className = 'stamp ' + (off ? 'off' : 'good');
  s.textContent = off ? 'needs work' : 'looks right';
  b.appendChild(s);
  b.appendChild(document.createTextNode(verdict.replace(/^\s*(good|off)\b[:\-—\s]*/i,'')));
  scroll();
  return off;
}
function roundMark(n){
  const d = document.createElement('div');
  d.className = 'round';
  d.textContent = `round ${n}`;
  el.inner.appendChild(d);
  scroll();
}

/* ---------- relay ----------
   The page holds the relay's address and token; the relay holds the API key.
   Both live in localStorage so they survive a reload. */
const RELAY = {
  url  : localStorage.getItem('relayUrl')   || '',
  token: localStorage.getItem('relayToken') || ''
};
const relayBase = () => RELAY.url.trim().replace(/\/+$/, '');
const usingRelay = () => !!relayBase();

function saveRelay(){
  RELAY.url   = $('#relayUrl').value.trim();
  RELAY.token = $('#relayToken').value.trim();
  localStorage.setItem('relayUrl', RELAY.url);
  localStorage.setItem('relayToken', RELAY.token);
  paintRelay();
}
function paintRelay(msg, state){
  const st = $('#relaySt');
  st.className = 'st' + (state ? ' ' + state : '');
  if(msg) return void (st.textContent = msg);
  st.textContent = usingRelay()
    ? (RELAY.token ? 'relay set — press Test relay' : 'address set, token missing')
    : 'no relay — the page cannot reach the API';
}

$('#relayUrl').value   = RELAY.url;
$('#relayToken').value = RELAY.token;
$('#relayUrl').oninput = $('#relayToken').oninput = saveRelay;
$('#relayHelpBtn').onclick = () => $('#relayHelp').classList.toggle('open');
paintRelay();

$('#testRelay').onclick = async () => {
  saveRelay();
  if(!usingRelay()) return paintRelay('enter the address the relay printed', 'bad');
  paintRelay('checking…');
  /* Both probes are answered by the relay itself and never touch the API, so
     this stays instant even when the API is congested — and costs nothing. */
  const t = () => AbortSignal.timeout(8000);
  try {
    /* /health is unauthenticated, so a failure here is the address, not the token. */
    const r = await fetch(relayBase() + '/health', {cache:'no-store', signal:t()});
    if(!r.ok) return paintRelay('something answered at that address, but it is not the relay', 'bad');
  } catch(e){
    return paintRelay(`cannot reach ${relayBase()} — is relay.py still running?`, 'bad');
  }
  if(!RELAY.token) return paintRelay('relay is up, but no token entered', 'bad');
  try {
    const v = await fetch(relayBase() + '/verify', {
      headers:{ 'Authorization':'Bearer ' + RELAY.token }, cache:'no-store', signal:t()
    });
    if(v.status === 401) return paintRelay('relay is up, but it rejected that token', 'bad');
    if(!v.ok)            return paintRelay('relay answered ' + v.status + ' — check the terminal', 'bad');
    paintRelay('relay works — you are set', 'good');
  } catch(e){
    paintRelay('relay stopped answering mid-check — see the terminal', 'bad');
  }
};

/* ---------- API ---------- */
async function complete(model, msgs){
  /* Built before the try so that a bug here — a null abort, an unserialisable
     message — surfaces as itself instead of being reported as a network fault. */
  const body = JSON.stringify({ model, messages: msgs });
  const signal = abort.signal;

  /* Through the relay when one is configured — it sends the relay token and the
     relay swaps in the real key. Otherwise the same-origin rewrite, which needs
     the host to be configured for it. */
  const relay = usingRelay();
  const endpoint = relay ? relayBase() + '/v1/chat/completions' : CONFIG.apiPath;
  const auth = relay ? RELAY.token : CONFIG.apiKey;

  let res;
  try {
    res = await fetch(endpoint, {
      method:'POST',
      headers:{ 'Authorization':'Bearer ' + auth, 'Content-Type':'application/json' },
      body, signal
    });
  } catch(e){
    if(e.name === 'AbortError' || !(e instanceof TypeError)) throw e;
    /* fetch() only throws for transport-level failures, and its message is
       always the useless "Failed to fetch". Say what actually went wrong. */
    if(relay) throw new Error(
      `Cannot reach the relay at ${relayBase()}. Check relay.py is still running in your terminal, and that the address matches the one it printed. ` +
      (location.protocol === 'https:' && relayBase().startsWith('http://')
        ? 'This page is https:// and the relay is http://, so Safari will block it outright — open the page from the relay instead.'
        : ''));
    throw new Error(location.protocol === 'file:'
      ? 'Opened as a local file, so there is no server to reach the API. Start relay.py and put its address in Settings.'
      : `No relay is set, and ${CONFIG.apiPath} is not reachable on this origin. Open Settings and configure a relay — that works on any host.`);
  }
  if(relay && res.status === 401)
    throw new Error('The relay rejected the token. Copy the relay token exactly as relay.py printed it into Settings — it changes every restart unless you pass --token.');
  /* The rewrite is missing rather than the API failing: a static host answers an
     unmapped /api path with its own 404 page instead of forwarding. */
  if(!relay && res.status === 404 && !(res.headers.get('content-type') || '').includes('json'))
    throw new Error(`${CONFIG.apiPath} returned a 404 page, so this host is not rewriting /api. Open Settings and configure a relay instead — it needs nothing from the host.`);
  if(res.status !== 200) throw new Error(`Error ${res.status}: ${(await res.text()).slice(0,280)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if(!content) throw new Error('Empty reply from ' + model);
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
const brainTurn = () => complete(CONFIG.brain, messages);
const look = (dataUrl, question) => complete(CONFIG.eyes, [{
  role:'user',
  content:[{ type:'text', text:question }, { type:'image_url', image_url:{ url:dataUrl } }]
}]);

const blobToDataUrl = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(new Error('could not read image'));
  r.readAsDataURL(blob);
});
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   THE MACHINE — Pyodide, plus a shell written in Python on top
   of os/shutil so ls, cp, mv, rm and friends act on the same
   filesystem the interpreter sees.
   ============================================================ */
let py = null, pyLoading = null, outBuf = '';

const SHELL_PY = String.raw`
import os, sys, io, shlex, shutil, glob, runpy, traceback, fnmatch

HOME = "/home/agent"
os.makedirs(HOME, exist_ok=True)
os.chdir(HOME)

def _fmt_size(n):
    return f"{n}" if n < 1024 else (f"{n/1024:.1f}K" if n < 1048576 else f"{n/1048576:.1f}M")

def _ls(args):
    long = "-l" in args or "-la" in args or "-al" in args
    hidden = "-a" in args or "-la" in args or "-al" in args
    paths = [a for a in args if not a.startswith("-")] or ["."]
    out = []
    for p in paths:
        if len(paths) > 1: out.append(p + ":")
        if os.path.isdir(p):
            names = sorted(os.listdir(p))
            if not hidden: names = [n for n in names if not n.startswith(".")]
            for n in names:
                full = os.path.join(p, n)
                if long:
                    st = os.stat(full)
                    kind = "d" if os.path.isdir(full) else "-"
                    out.append(f"{kind} {_fmt_size(st.st_size):>8}  {n}")
                else:
                    out.append(n + ("/" if os.path.isdir(full) else ""))
        elif os.path.exists(p):
            out.append(p)
        else:
            out.append(f"ls: {p}: no such file")
    return "\n".join(out)

def _tree(root=".", prefix=""):
    out = []
    try: entries = sorted(os.listdir(root))
    except Exception as e: return f"tree: {e}"
    entries = [e for e in entries if not e.startswith(".")]
    for i, name in enumerate(entries):
        last = i == len(entries) - 1
        full = os.path.join(root, name)
        out.append(prefix + ("+-- " if last else "|-- ") + name)
        if os.path.isdir(full):
            out.append(_tree(full, prefix + ("    " if last else "|   ")))
    return "\n".join([o for o in out if o])

def _grep(args):
    if len(args) < 2: return "grep: need a pattern and a file"
    pat, files = args[0], args[1:]
    out = []
    for f in files:
        try:
            for i, line in enumerate(open(f, errors="replace"), 1):
                if pat in line:
                    out.append(f"{f}:{i}: {line.rstrip()}")
        except Exception as e:
            out.append(f"grep: {f}: {e}")
    return "\n".join(out) or "(no matches)"

def _run_file(path, argv):
    buf = io.StringIO()
    old_out, old_err, old_argv = sys.stdout, sys.stderr, sys.argv
    sys.stdout = sys.stderr = buf
    sys.argv = [path] + argv
    try:
        runpy.run_path(path, run_name="__main__")
    except SystemExit:
        pass
    except Exception:
        buf.write(traceback.format_exc())
    finally:
        sys.stdout, sys.stderr, sys.argv = old_out, old_err, old_argv
    return buf.getvalue()

def sh(line):
    line = line.strip()
    if not line or line.startswith("#"): return ""

    redirect, append, target = False, False, None
    if ">>" in line:
        line, target = line.split(">>", 1); redirect, append = True, True
    elif ">" in line and not line.strip().startswith("echo >"):
        line, target = line.split(">", 1); redirect = True
    if target is not None: target = target.strip()

    try:
        parts = shlex.split(line)
    except ValueError as e:
        return f"parse error: {e}"
    if not parts: return ""
    cmd, args = parts[0], parts[1:]
    out = ""

    try:
        if cmd == "pwd":       out = os.getcwd()
        elif cmd == "cd":
            os.chdir(os.path.expanduser(args[0]) if args else HOME); out = os.getcwd()
        elif cmd == "ls":      out = _ls(args)
        elif cmd == "tree":    out = _tree(args[0] if args else ".")
        elif cmd == "cat":
            out = "\n".join(open(a, errors="replace").read() for a in args)
        elif cmd == "head":
            n = 10
            if args and args[0] == "-n": n = int(args[1]); args = args[2:]
            out = "".join(open(args[0], errors="replace").readlines()[:n])
        elif cmd == "tail":
            n = 10
            if args and args[0] == "-n": n = int(args[1]); args = args[2:]
            out = "".join(open(args[0], errors="replace").readlines()[-n:])
        elif cmd == "wc":
            f = args[-1]; t = open(f, errors="replace").read()
            out = f"{len(t.splitlines())} {len(t.split())} {len(t)} {f}"
        elif cmd == "echo":    out = " ".join(args)
        elif cmd == "mkdir":   [os.makedirs(a, exist_ok=True) for a in args if not a.startswith("-")]
        elif cmd == "touch":
            for a in args: open(a, "a").close()
        elif cmd == "rm":
            for a in [x for x in args if not x.startswith("-")]:
                if os.path.isdir(a): shutil.rmtree(a)
                else: os.remove(a)
        elif cmd == "rmdir":   [shutil.rmtree(a) for a in args]
        elif cmd == "cp":
            src, dst = args[-2], args[-1]
            if os.path.isdir(src): shutil.copytree(src, dst, dirs_exist_ok=True)
            else: shutil.copy2(src, dst)
        elif cmd == "mv":      shutil.move(args[-2], args[-1])
        elif cmd == "find":
            root = args[0] if args and not args[0].startswith("-") else "."
            pat = args[args.index("-name") + 1] if "-name" in args else "*"
            hits = []
            for dirpath, dirnames, filenames in os.walk(root):
                for f in filenames:
                    if fnmatch.fnmatch(f, pat): hits.append(os.path.join(dirpath, f))
            out = "\n".join(hits) or "(nothing)"
        elif cmd == "du":
            total = sum(os.path.getsize(os.path.join(d, f))
                        for d, _, fs in os.walk(args[0] if args else ".") for f in fs)
            out = _fmt_size(total)
        elif cmd == "which":
            out = "\n".join(f"{a}: {'builtin' if a in BUILTINS else 'not found'}" for a in args)
        elif cmd == "help":    out = "commands: " + " ".join(sorted(BUILTINS))
        elif cmd in ("python", "python3"):
            if not args: out = sys.version
            elif args[0] == "-c": out = _exec_str(" ".join(args[1:]))
            else: out = _run_file(args[0], args[1:])
        elif cmd == "pip":     out = "(pip is handled outside the shell — just say pip install <name>)"
        else:
            out = f"{cmd}: not available. This is a Python machine — use a PY block instead."
    except Exception as e:
        out = f"{cmd}: {e}"

    out = out if isinstance(out, str) else ""
    if redirect and target:
        with open(target, "a" if append else "w") as f: f.write(out + "\n")
        return ""
    return out

def _exec_str(code):
    buf = io.StringIO()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = buf
    try:
        exec(code, {"__name__": "__main__"})
    except Exception:
        buf.write(traceback.format_exc())
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    return buf.getvalue()

BUILTINS = {"pwd","cd","ls","tree","cat","head","tail","wc","echo","mkdir","touch",
            "rm","rmdir","cp","mv","find","du","which","help","python","python3"}

def sh_many(text):
    chunks = []
    for line in text.split("\n"):
        line = line.strip()
        if not line: continue
        r = sh(line)
        chunks.append(f"$ {line}" + (("\n" + r) if r else ""))
    return "\n".join(chunks)

def ls_json():
    import json
    rows = []
    for dirpath, dirnames, filenames in os.walk(HOME):
        for f in filenames:
            full = os.path.join(dirpath, f)
            try: rows.append({"path": os.path.relpath(full, HOME), "size": os.path.getsize(full)})
            except Exception: pass
    return json.dumps(sorted(rows, key=lambda r: r["path"]))
`;

function termWrite(text, cls){
  const s = document.createElement('span');
  if(cls) s.className = cls;
  s.textContent = text.endsWith('\n') ? text : text + '\n';
  el.term.appendChild(s);
  el.term.scrollTop = el.term.scrollHeight;
}

async function wake(){
  if(py) return py;
  if(pyLoading) return pyLoading;

  pyLoading = (async () => {
    el.machineSt.textContent = 'downloading python…';
    termWrite('booting CPython…');
    await new Promise((res, rej) => {
      if(window.loadPyodide) return res();
      const s = document.createElement('script');
      s.src = CONFIG.pyodide;
      s.onload = res;
      s.onerror = () => rej(new Error('could not reach the Pyodide CDN'));
      document.head.appendChild(s);
    });

    el.machineSt.textContent = 'starting…';
    const p = await loadPyodide({
      stdout: s => { outBuf += s + '\n'; termWrite(s); },
      stderr: s => { outBuf += s + '\n'; termWrite(s, 'bad'); }
    });
    p.runPython(SHELL_PY);
    py = p;
    el.machineSt.textContent = 'ready · ' + p.runPython('import sys; sys.version.split()[0]');
    termWrite('python ' + p.runPython('import sys; sys.version.split()[0]') + ' — /home/agent');
    return p;
  })();

  try { return await pyLoading; }
  catch(e){ pyLoading = null; el.machineSt.textContent = 'failed'; throw e; }
}

/* write a file the brain emitted into the machine's filesystem */
async function putFile(name, content){
  const p = await wake();
  p.globals.set('_n', name.replace(/^\.?\//,''));
  p.globals.set('_c', content);
  p.runPython(`
import os
_path = os.path.join(HOME, _n)
os.makedirs(os.path.dirname(_path) or HOME, exist_ok=True)
open(_path, "w").write(_c)
`);
}

async function runShell(text){
  const p = await wake();
  p.globals.set('_cmds', text);
  return p.runPython('sh_many(_cmds)') || '';
}

async function runPy(code){
  const p = await wake();
  outBuf = '';
  try {
    await p.loadPackagesFromImports(code);
  } catch(e){ termWrite('(package load: ' + e.message + ')', 'bad'); }
  try {
    const result = await p.runPythonAsync(code);
    if(result !== undefined && result !== null) outBuf += String(result) + '\n';
  } catch(e){
    outBuf += String(e.message || e);
    termWrite(String(e.message || e), 'bad');
  }
  return outBuf;
}

async function pipInstall(names){
  const p = await wake();
  await p.loadPackage('micropip');
  const micropip = p.pyimport('micropip');
  const done = [];
  for(const n of names){
    try { await micropip.install(n); done.push(n + ' ok'); }
    catch(e){ done.push(n + ' failed: ' + (e.message || e)); }
  }
  return done.join('\n');
}

async function listFiles(){
  if(!py){ el.files.innerHTML = '<div class="pane-note" style="padding:16px;font-family:var(--mono);font-size:11px;color:var(--muted)">Machine is asleep.</div>'; return; }
  let rows = [];
  try { rows = JSON.parse(py.runPython('ls_json()')); } catch(e){ }
  el.filesSt.textContent = `${CONFIG.home} · ${rows.length} files`;
  el.files.innerHTML = '';
  for(const r of rows){
    const d = document.createElement('div');
    d.className = 'frow';
    d.innerHTML = `<span class="fn"></span><span class="fs"></span><button class="ghost">Save</button>`;
    d.querySelector('.fn').textContent = r.path;
    d.querySelector('.fs').textContent = r.size < 1024 ? r.size + 'B' : (r.size/1024).toFixed(1) + 'K';
    d.querySelector('button').onclick = () => {
      py.globals.set('_g', r.path);
      const text = py.runPython('open(os.path.join(HOME,_g), errors="replace").read()');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], {type:'text/plain'}));
      a.download = r.path.split('/').pop();
      a.click();
    };
    el.files.appendChild(d);
  }
}
$('#refresh').onclick = listFiles;
$('#boot').onclick = async () => {
  showPanel('machine');
  try { await wake(); listFiles(); }
  catch(e){ termWrite(e.message, 'bad'); }
};

/* manual terminal */
let cmdMode = 'sh';
$('#mode').onclick = () => {
  cmdMode = cmdMode === 'sh' ? 'py' : 'sh';
  $('#mode').textContent = cmdMode;
  el.cmd.placeholder = cmdMode === 'sh' ? 'ls -la' : 'print(sum(range(10)))';
};
el.cmd.addEventListener('keydown', async e => {
  if(e.key !== 'Enter') return;
  const line = el.cmd.value.trim();
  if(!line) return;
  el.cmd.value = '';
  termWrite((cmdMode === 'sh' ? '$ ' : '>>> ') + line, cmdMode === 'sh' ? 'in' : 'py');
  try {
    if(cmdMode === 'sh'){
      if(/^pip\s+install\s+/.test(line)) termWrite(await pipInstall(line.split(/\s+/).slice(2)));
      else termWrite(await runShell(line));
    } else {
      await runPy(line);
    }
    listFiles();
  } catch(err){ termWrite(err.message, 'bad'); }
});

/* ---------- blocks ---------- */
const BLOCK = /<<<(FILE|IMAGE|RUN|PY)(?:\s+([^\n>]+))?>>>\r?\n([\s\S]*?)<<<END>>>/g;
function extract(reply){
  const blocks = [];
  const prose = reply.replace(BLOCK, (_, kind, name, inner) => {
    const k = kind.toLowerCase();
    blocks.push({ kind:k, name:(name||'').trim(), content: inner.replace(/\s+$/,'') });
    return k === 'run' ? '\n\n`→ shell`\n\n' : k === 'py' ? '\n\n`→ python`\n\n' : `\n\n\`→ ${(name||'').trim()}\`\n\n`;
  });
  return { prose: prose.trim(), blocks };
}

/* ---------- preview ---------- */
function assemble(files){
  const byName = new Map(files.map(f => [f.name.replace(/^\.?\//,''), f.content]));
  let entry = byName.get('index.html');
  if(!entry){
    const html = files.find(f => /\.html?$/i.test(f.name));
    if(!html) return null;
    entry = html.content;
  }
  let doc = entry.replace(/<link\b[^>]*href=["']([^"':]+\.css)["'][^>]*>/gi, (m, href) => {
    const css = byName.get(href.replace(/^\.?\//,''));
    return css ? `<style>\n${css}\n</style>` : m;
  });
  doc = doc.replace(/<script\b[^>]*src=["']([^"':]+\.js)["'][^>]*>\s*<\/script>/gi, (m, src) => {
    const js = byName.get(src.replace(/^\.?\//,''));
    return js ? `<script>\n${js}\n<\/script>` : m;
  });
  const shim = `<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"><\/script>`;
  return /<head[^>]*>/i.test(doc) ? doc.replace(/<head([^>]*)>/i, `<head$1>${shim}`) : shim + doc;
}
function mount(doc){
  return new Promise(resolve => {
    el.frame.onload = () => resolve();
    el.frame.srcdoc = doc;
    setTimeout(resolve, 4000);
  });
}
async function shootPreview(){
  const win = el.frame.contentWindow;
  if(!win || !win.html2canvas) throw new Error('preview would not load');
  const canvas = await win.html2canvas(win.document.documentElement, {
    backgroundColor:'#ffffff', useCORS:true, logging:false,
    width: win.document.documentElement.scrollWidth,
    height: Math.min(win.document.documentElement.scrollHeight, 2000)
  });
  return canvas.toDataURL('image/jpeg', 0.72);
}

/* ---------- Pollinations ---------- */
function cleanFilename(prompt){
  let c = prompt.replace(/[^\w\s-]/g, '').trim();
  c = c.replace(/[\s-]+/g, '_');
  return c.slice(0, 30).toLowerCase() || 'image';
}
async function pollinate(prompt, {width, height, model}){
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt)
    + `?width=${width}&height=${height}&model=${model}&nologo=true`;
  for(let attempt = 1; attempt <= 3; attempt++){
    const res = await fetch(url, {signal:abort.signal});
    if(res.ok) return await res.blob();
    if(res.status === 429){
      if(attempt === 3) throw new Error('rate limited — wait 10s');
      await wait(10000);
      continue;
    }
    throw new Error('HTTP ' + res.status);
  }
}

/* ---------- artifacts ---------- */
function updateCount(){
  el.count.textContent = artifacts.length ? `(${artifacts.length})` : '';
  $('#saveAll').disabled = !artifacts.length;
}
function download(art){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(art.blob);
  a.download = art.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('#saveAll').onclick = async () => { for(const a of artifacts){ download(a); await wait(350); } };
updateCount();

function shelfIn(body){
  let g = body.querySelector('.arts');
  if(!g){ g = document.createElement('div'); g.className='arts'; body.appendChild(g); }
  return g;
}
function fileCard(body, name, content){
  const art = {name, blob:new Blob([content], {type:'text/plain;charset=utf-8'})};
  artifacts.push(art); updateCount();
  const card = document.createElement('div');
  card.className = 'art';
  card.innerHTML = `<div class="doc"></div><div class="meta"><span class="nm"></span><button class="dl">Save</button></div>`;
  card.querySelector('.doc').textContent = content.slice(0, 600);
  card.querySelector('.nm').textContent = name;
  card.querySelector('.dl').onclick = () => download(art);
  shelfIn(body).appendChild(card);
  scroll();
}
function imageCard(body, name){
  const card = document.createElement('div');
  card.className = 'art';
  card.innerHTML = `<div class="thumb busy">rendering…</div><div class="meta"><span class="nm"></span><button class="dl" disabled>Save</button></div>`;
  card.querySelector('.nm').textContent = name;
  shelfIn(body).appendChild(card);
  scroll();
  return {
    done(blob){
      const art = {name, blob};
      artifacts.push(art); updateCount();
      const t = card.querySelector('.thumb');
      t.classList.remove('busy');
      t.innerHTML = '<img alt="">';
      const img = t.querySelector('img');
      img.src = URL.createObjectURL(blob);
      img.onclick = () => window.open(img.src, '_blank');
      const b = card.querySelector('.dl');
      b.disabled = false; b.onclick = () => download(art);
    },
    failed(why){
      card.classList.add('fail');
      const t = card.querySelector('.thumb');
      t.classList.remove('busy'); t.textContent = why;
    }
  };
}

/* ---------- markdown ---------- */
const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function md(src){
  let h = esc(src);
  h = h.replace(/```[a-z]*\n?([\s\S]*?)```/g, (_,c) => `<pre><code>${c.replace(/\s+$/,'')}</code></pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h1>$1</h1>');
  h = h.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/(^|\W)\*([^*\n]+)\*/g,'$1<em>$2</em>');
  h = h.replace(/^\s*[-*] (.*)$/gm,'<li>$1</li>').replace(/^\s*\d+\. (.*)$/gm,'<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g,'<ul>$1</ul>');
  return h.split(/\n{2,}/).map(b => /^\s*<(h\d|ul|pre|li)/.test(b) ? b : `<p>${b.replace(/\n/g,'<br>')}</p>`).join('\n');
}

/* ---------- attachment ---------- */
$('#attach').onclick = () => el.picker.click();
$('#dropAttach').onclick = dropAttach;
function dropAttach(){ pending = null; el.attached.classList.remove('on'); el.picker.value=''; }
el.picker.onchange = async () => {
  const f = el.picker.files?.[0];
  if(!f) return;
  try {
    pending = { name:f.name, dataUrl: await blobToDataUrl(f) };
    el.pic.src = pending.dataUrl;
    el.picName.textContent = f.name;
    el.attached.classList.add('on');
    el.q.focus();
  } catch(e){ el.status.textContent = e.message; }
};

/* ---------- the loop ---------- */
el.send.onclick = send;
el.stop.onclick = () => abort && abort.abort();
el.q.addEventListener('input', () => {
  el.q.style.height = 'auto';
  el.q.style.height = Math.min(el.q.scrollHeight, 150) + 'px';
});
el.q.addEventListener('keydown', e => {
  if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); }
});

async function send(){
  const input = el.q.value.trim();
  if((!input && !pending) || busy) return;

  const gap = (Date.now() - lastSend) / 1000;
  if(lastSend && gap < CONFIG.cooldown){
    el.status.textContent = `hold on — ${Math.ceil(CONFIG.cooldown - gap)}s`;
    return;
  }
  lastSend = Date.now();

  abort = new AbortController();
  busy = true;
  el.send.disabled = true;
  el.stop.classList.add('on');
  const attachment = pending;
  el.q.value = ''; el.q.style.height = 'auto';
  dropAttach();

  you(input || '(image)', attachment?.dataUrl);

  try {
    let userText = input;

    if(attachment){
      el.status.textContent = 'eyes reading the image…';
      let report;
      try {
        report = await look(attachment.dataUrl,
          input ? `Describe this image in detail, then answer: ${input}`
                : 'Describe this image in detail — subject, setting, text, colours, anything notable.');
      } catch(e){
        if(e.name === 'AbortError') throw e;
        report = `(could not read the image: ${e.message})`;
      }
      eyesSays(report, attachment.dataUrl);
      userText = `${input || 'What do you make of this?'}\n\n[EYES] The user attached ${attachment.name}:\n${report}`;
    }

    messages.push({role:'user', content:userText});

    const maxRounds = +$('#maxRounds').value;
    const reviewing = $('#review').checked;
    const mayRun = $('#canRun').checked;

    for(let round = 1; round <= maxRounds; round++){
      if(round > 1) roundMark(round);

      const body = bubble('Big Agent','bot');
      body.innerHTML = '<div class="thinking">thinking…</div>';
      el.status.textContent = 'brain, round ' + round;

      const reply = await brainTurn();
      messages.push({role:'assistant', content:reply});

      const allow = $('#canMake').checked;
      const { prose, blocks } = allow ? extract(reply) : { prose: reply, blocks: [] };
      body.innerHTML = md(prose || '…');

      let critique = null;

      /* --- files: onto the shelf and into the machine's filesystem --- */
      const files = blocks.filter(b => b.kind === 'file');
      for(const f of files) fileCard(body, f.name, f.content);
      if(files.length && mayRun){
        try { for(const f of files) await putFile(f.name, f.content); listFiles(); }
        catch(e){ termWrite('could not save files into the machine: ' + e.message, 'bad'); }
      }

      /* --- render and review --- */
      if(files.length){
        const doc = assemble(files);
        if(doc){
          el.status.textContent = 'rendering the build';
          showPanel('preview');
          await mount(doc);
          el.previewSt.textContent = files.map(f => f.name).join(' · ');
          await wait(900);

          if(reviewing){
            el.status.textContent = 'eyes reviewing the build';
            try {
              const shot = await shootPreview();
              const verdict = await look(shot,
                `This is a screenshot of a page built to do this: "${input || 'the request above'}"\n\nStart your reply with GOOD or OFF — GOOD if the page looks finished and correct, OFF if something is broken, missing, unstyled, overlapping, or unreadable. Then say in one or two sentences what you actually see and what is wrong.`);
              const off = eyesSays(verdict, shot);
              messages.push({role:'user', content:`[EYES] screenshot of the build: ${verdict}`});
              if(off) critique = verdict;
            } catch(e){
              if(e.name === 'AbortError') throw e;
              eyesSays('GOOD — could not screenshot the preview (' + e.message + '), skipping review.');
            }
          }
        }
      }

      /* --- python --- */
      const pys = blocks.filter(b => b.kind === 'py');
      const runs = blocks.filter(b => b.kind === 'run');

      if((pys.length || runs.length) && !mayRun){
        machineSays('(the machine is switched off in Settings)');
        messages.push({role:'user', content:'[MACHINE] disabled by the user — answer without it.'});
      } else {
        for(const b of pys){
          showPanel('machine');
          el.status.textContent = 'running python';
          termWrite('>>> ' + b.content.split('\n')[0] + (b.content.includes('\n') ? ' …' : ''), 'py');
          let out;
          try { out = await runPy(b.content); }
          catch(e){ if(e.name === 'AbortError') throw e; out = 'machine error: ' + e.message; }
          machineSays(out);
          messages.push({role:'user', content:`[MACHINE] python output:\n${(out||'(no output)').slice(-4000)}`});
          if(/Traceback|Error/.test(out)) critique = 'python raised an error: ' + out.slice(-400);
          listFiles();
        }

        for(const b of runs){
          showPanel('machine');
          el.status.textContent = 'running shell';
          let out;
          try {
            const pipLines = b.content.split('\n').filter(l => /^\s*pip\s+install\s+/.test(l));
            const rest = b.content.split('\n').filter(l => !/^\s*pip\s+install\s+/.test(l)).join('\n');
            out = '';
            for(const p of pipLines) out += await pipInstall(p.trim().split(/\s+/).slice(2)) + '\n';
            if(rest.trim()) out += await runShell(rest);
          } catch(e){ if(e.name === 'AbortError') throw e; out = 'machine error: ' + e.message; }
          termWrite(out);
          machineSays(out);
          messages.push({role:'user', content:`[MACHINE] shell output:\n${(out||'(no output)').slice(-4000)}`});
          listFiles();
        }
      }

      /* --- images --- */
      const images = blocks.filter(b => b.kind === 'image').slice(0, +$('#maxImgs').value);
      if(images.length){
        const [w,h] = $('#imgSize').value.split('x').map(Number);
        const model = $('#imgModel').value;
        for(const img of images){
          const name = /\.(jpg|jpeg|png)$/i.test(img.name) ? img.name : cleanFilename(img.content) + '.jpg';
          const card = imageCard(body, name);
          el.status.textContent = 'rendering ' + name;
          let blob;
          try { blob = await pollinate(img.content, {width:w, height:h, model}); card.done(blob); }
          catch(e){ if(e.name === 'AbortError') throw e; card.failed(e.message); continue; }

          if(reviewing){
            el.status.textContent = 'eyes checking ' + name;
            try {
              const verdict = await look(await blobToDataUrl(blob),
                `This image was generated from the prompt: "${img.content}"\n\nStart your reply with GOOD or OFF — GOOD if it matches, OFF if it misses something important. Then one sentence on what is actually shown.`);
              const off = eyesSays(verdict);
              messages.push({role:'user', content:`[EYES] ${name}: ${verdict}`});
              if(off) critique = verdict;
            } catch(e){ if(e.name === 'AbortError') throw e; }
          }
        }
      }

      if(!critique) break;
      if(round === maxRounds){
        messages.push({role:'user', content:'That was the last revision round. Tell the user plainly what still is not right.'});
        const b2 = bubble('Big Agent','bot');
        b2.innerHTML = '<div class="thinking">wrapping up…</div>';
        const final = await brainTurn();
        messages.push({role:'assistant', content:final});
        b2.innerHTML = md(extract(final).prose || final);
        break;
      }
      messages.push({role:'user', content:'Fix what came back and emit the corrected files in full.'});
    }

    el.status.textContent = '';

  } catch(e){
    const last = el.inner.querySelector('.msg.bot:last-child .body');
    const target = (last && last.querySelector('.thinking')) ? last : bubble('Big Agent','bot');
    target.innerHTML = e.name === 'AbortError'
      ? '<div class="err">Stopped.</div>'
      : `<div class="err">${esc(e.message)}</div>`;
    el.status.textContent = '';
  } finally {
    busy = false;
    el.send.disabled = false;
    el.stop.classList.remove('on');
    abort = null;
    el.q.focus();
    scroll();
  }
}

el.q.focus();
