"""Check the MCP tools' descriptions the way docs/AUTOMATION.md asks (few tools, an action enum, a worked example,
short): reads tools/list from a server and reports what to fix, plus how much context the definitions cost.

  VOICEBOX_URL=https://voiceboxstudio.vercel.app MCP_TOKEN=... python3 scripts/check_tools.py [--lean]

For the check by a cheaper model (phase 9), paste a tool's description into it and ask it to make the call for a task;
a wrong call means the description needs work.
"""
import json, os, sys, urllib.request

AUTO = {"approvals", "control", "run", "playbook", "repo", "edit_video", "inspect_media", "browse", "video_template", "repurpose", "workflow", "agents", "audit", "memory", "find_tools", "call_tool"}


def tools(url, token):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    raw = urllib.request.urlopen(req, timeout=120).read().decode()
    line = next((x[6:] for x in raw.splitlines() if x.startswith("data: ")), raw)
    return json.loads(line)["result"]["tools"]


def main():
    base = os.environ.get("VOICEBOX_URL", "http://localhost:3000").rstrip("/")
    ts = tools(f"{base}/api/mcp{'/lean' if '--lean' in sys.argv else ''}", os.environ["MCP_TOKEN"])
    size = len(json.dumps(ts))
    print(f"{len(ts)} tools, {size:,} characters of definitions (about {size // 4:,} tokens every session)")
    bad = 0
    for t in ts:
        d, props = t.get("description", ""), (t.get("inputSchema") or {}).get("properties", {})
        issues = []
        if len(d) > 2500:
            issues.append(f"description is {len(d)} characters (aim under 2,500)")
        if t["name"] in AUTO and "Example" not in d:
            issues.append("no worked example")
        if "action" in props and "enum" not in json.dumps(props["action"]):
            issues.append("action isn't a fixed list")
        if issues:
            bad += 1
            print(f"  {t['name']}: {'; '.join(issues)}")
    print("all clear" if not bad else f"{bad} to fix")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
