---
name: Bug report
about: Something in drawer does not work as documented
labels: bug
---

<!-- Security problems: do not open an issue. Use the Security tab, "Report a vulnerability" (see SECURITY.md). -->
<!-- Do not paste import tokens or your server's address. A model or spec that shows the problem is welcome if you may share it. -->

**Where**
<!-- Web app (laptop or phone), the `drawer` CLI, the built-in agent, a gate or measurement, a render, an import (which site) -->

**Server version**
<!-- `curl -s http://localhost:3050/api/health`: the `version` and `openscad` fields -->

**How the server is deployed**
<!-- The published image or a build from source? How do you reach it (loopback, a private address, a reverse proxy)? -->

**What happened**

**What you expected**

**Steps to reproduce**
1.

**Logs**
<!-- `docker compose logs --tail 50 drawer`, and for the agent `journalctl --user -u drawer-agent -n 50`, with tokens removed. For the app: browser and version. -->
