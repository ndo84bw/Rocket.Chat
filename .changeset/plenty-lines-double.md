---
'@rocket.chat/meteor': patch
---

Fixes a reload loop when opening a link to an older message (`?msg=`): the room would flash the linked message and then keep loading until it hit the server rate limit (429) instead of settling. The room now opens positioned on the linked message.
