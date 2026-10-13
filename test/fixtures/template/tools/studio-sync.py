"""Receives script edits made inside Roblox Studio and writes them into the repo.

Run through ./dev (started automatically) or directly: python tools/studio-sync.py
Pairs with the Studio plugin in tools/StudioSyncPlugin.luau.

Commands:
  python tools/studio-sync.py              run the receiver
  python tools/studio-sync.py conflicts    list files held back as conflicts
  python tools/studio-sync.py take-studio <file|all>   overwrite the repo file with the held Studio version
  python tools/studio-sync.py take-disk <file|all>     drop the held Studio version and keep the repo file
"""

import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.join(ROOT, "default.project.json")
SETTINGS = os.path.join(ROOT, "tools", "studio-sync.json")
WORK = os.path.join(ROOT, ".studio-sync")
STATE = os.path.join(WORK, "state.json")
CONFLICTS = os.path.join(WORK, "conflicts")
LOG = os.path.join(WORK, "sync.log")
SUFFIX = {"ModuleScript": "", "Script": ".server", "LocalScript": ".client"}
LOCK = threading.Lock()
SKIPPED = set()


def load_settings():
    with open(SETTINGS, encoding="utf-8") as handle:
        return json.load(handle)


def project_roots():
    with open(PROJECT, encoding="utf-8") as handle:
        tree = json.load(handle)["tree"]
    skip = set(load_settings().get("skip", []))
    roots = []

    def walk(node, names):
        if not isinstance(node, dict):
            return
        path = node.get("$path")
        if path and names:
            if path not in skip and os.path.isdir(os.path.join(ROOT, path)):
                roots.append({"instance": names, "dir": path})
            return
        for key, child in node.items():
            if not key.startswith("$"):
                walk(child, names + [key])

    walk(tree, [])
    return roots


def log(message):
    line = time.strftime("%H:%M:%S ") + message
    print(line, flush=True)
    os.makedirs(WORK, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def normalise(text):
    return text.replace("\r\n", "\n").rstrip("\n")


def digest(text):
    return hashlib.sha1(normalise(text).encode("utf-8")).hexdigest()


def read_state():
    try:
        with open(STATE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def write_state(state):
    os.makedirs(WORK, exist_ok=True)
    temp = STATE + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=0, sort_keys=True)
    os.replace(temp, STATE)


def safe_segment(name):
    return bool(name) and name not in (".", "..") and not any(ch in name for ch in '\\/:*?"<>|') and name == name.strip()


def resolve(roots, names, class_name):
    suffix = SUFFIX.get(class_name)
    if suffix is None:
        return None, False
    for root in sorted(roots, key=lambda item: -len(item["instance"])):
        prefix = root["instance"]
        if names[: len(prefix)] != prefix:
            continue
        rest = names[len(prefix):]
        if not all(safe_segment(part) for part in rest):
            return None, False
        base = os.path.join(ROOT, root["dir"], *rest[:-1]) if rest else os.path.join(ROOT, root["dir"])
        if not rest:
            return os.path.join(base, "init" + suffix + ".luau"), os.path.isfile(os.path.join(base, "init" + suffix + ".luau"))
        leaf = rest[-1]
        options = [
            os.path.join(base, leaf + suffix + ".luau"),
            os.path.join(base, leaf, "init" + suffix + ".luau"),
            os.path.join(base, leaf + suffix + ".lua"),
            os.path.join(base, leaf, "init" + suffix + ".lua"),
        ]
        for option in options:
            if os.path.isfile(option):
                return option, True
        if os.path.isdir(os.path.join(base, leaf)):
            return options[1], False
        return options[0], False
    return None, False


def read_file(path):
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def write_file(path, source, like=None):
    text = source.replace("\r\n", "\n")
    if not text.endswith("\n"):
        text += "\n"
    if like is not None and "\r\n" in like:
        text = text.replace("\n", "\r\n")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def conflict_path(rel):
    return os.path.join(CONFLICTS, rel.replace("\\", "/").replace("/", "__"))


def hold(rel, source):
    os.makedirs(CONFLICTS, exist_ok=True)
    with open(conflict_path(rel), "w", encoding="utf-8", newline="") as handle:
        handle.write(source.replace("\r\n", "\n"))


def apply(roots, state, item, initial):
    names = item.get("path")
    source = item.get("source")
    if not isinstance(names, list) or not isinstance(source, str):
        return "bad"
    path, exists = resolve(roots, names, item.get("className"))
    if not path:
        return "unmapped"
    rel = os.path.relpath(path, ROOT).replace("\\", "/")
    incoming = digest(source)
    if not exists:
        if not os.path.isdir(os.path.dirname(path)):
            if rel not in SKIPPED:
                SKIPPED.add(rel)
                log("skip  " + rel + "  (no matching folder in the repo; create it by hand to track this script)")
            return "unmapped"
        write_file(path, source)
        state[rel] = incoming
        log("new   " + rel)
        return "new"
    disk_text = read_file(path)
    disk = digest(disk_text)
    if disk == incoming:
        state[rel] = incoming
        held = conflict_path(rel)
        if os.path.isfile(held):
            os.remove(held)
        return "same"
    known = state.get(rel)
    if known == disk:
        write_file(path, source, disk_text)
        state[rel] = incoming
        log("pull  " + rel)
        return "pulled"
    if known == incoming:
        return "stale"
    hold(rel, source)
    log(("differs at start  " if initial else "conflict  ") + rel)
    return "conflict"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    roots = []

    def reply(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/config":
            self.reply(404, {"error": "unknown"})
            return
        settings = load_settings()
        self.reply(200, {
            "placeIds": settings.get("placeIds", []),
            "roots": [root["instance"] for root in Handler.roots],
        })

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if self.path != "/sync":
            self.reply(404, {"error": "unknown"})
            return
        try:
            payload = json.loads(raw.decode("utf-8"))
            scripts = payload["scripts"]
        except (ValueError, KeyError, UnicodeDecodeError):
            self.reply(400, {"error": "bad payload"})
            return
        counts = {}
        with LOCK:
            state = read_state()
            for item in scripts:
                result = apply(Handler.roots, state, item, bool(payload.get("initial")))
                counts[result] = counts.get(result, 0) + 1
            write_state(state)
        self.reply(200, counts)

    def log_message(self, *args):
        pass


def held_files():
    if not os.path.isdir(CONFLICTS):
        return []
    return sorted(os.listdir(CONFLICTS))


def resolve_command(action, target):
    names = held_files() if target == "all" else [target.replace("\\", "/").replace("/", "__")]
    state = read_state()
    for name in names:
        held = os.path.join(CONFLICTS, name)
        rel = name.replace("__", "/")
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(held) or not os.path.isfile(path):
            print("skip  " + rel)
            continue
        if action == "take-studio":
            source = read_file(held)
            write_file(path, source, read_file(path))
            state[rel] = digest(source)
            print("studio -> repo  " + rel)
        else:
            state[rel] = digest(read_file(held))
            print("kept repo  " + rel + "  (touch the file so Rojo pushes it into Studio)")
        os.remove(held)
    write_state(state)


def main():
    args = sys.argv[1:]
    if args and args[0] == "conflicts":
        for name in held_files():
            print(name.replace("__", "/"))
        return
    if len(args) == 2 and args[0] in ("take-studio", "take-disk"):
        resolve_command(args[0], args[1])
        return
    settings = load_settings()
    Handler.roots = project_roots()
    if not settings.get("placeIds"):
        log("no placeIds in tools/studio-sync.json: the Studio plugin stays idle until you add the place id of this game")
    port = int(settings.get("port", 34873))
    log("studio-sync listening on 127.0.0.1:%d for %s" % (port, ", ".join(".".join(root["instance"]) for root in Handler.roots)))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
