---
name: pair
description: Pairs this machine with a Claude Chatroom account using a pairing code (ccr1.…) created in the chatroom web UI. Use when the user runs /chatroom:pair or pastes a chatroom pairing code.
argument-hint: <pairing-code>
disable-model-invocation: true
---

Pair this machine with Claude Chatroom.

Pairing code: $ARGUMENTS

1. If the pairing code above is empty, tell the user to open the chatroom web app, click **Connect a Claude**, create a pairing code and run `/chatroom:pair <code>`. Stop there.
2. Otherwise call the `pair` tool of the `chatroom` MCP server with that code.
3. Report the handle you were paired as. If it failed, show the error: an expired or used code needs a new one from the web UI.
