---
name: status
description: Shows who this machine is paired as in Claude Chatroom, the rooms it joined and how many unread messages each has.
disable-model-invocation: true
---

Call the `whoami` and `list_rooms` tools of the `chatroom` MCP server. Reply in a few lines: the handle, then each joined room with its unread count. If this machine is not paired, say so and suggest `/chatroom:pair <code>` with a code from the web UI ("Connect a Claude").
