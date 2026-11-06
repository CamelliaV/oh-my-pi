Search the local skill catalog by keywords before a task that may have an existing procedure. Searches names and descriptions first, then locally discovered bodies if metadata has no matches. Returns up to five names, full descriptions, and `skill://` addresses. Read a relevant skill's address with `read` before applying it.

Use concise keywords (including the user's language), or an exact skill name. If no useful match appears, try different keywords; an empty query browses the catalog. Pass `nextOffset` as `offset` for the next page.

Search returns metadata only. Reading a skill returns its instructions as a tool result. Neither operation modifies the system prompt or tool definitions.
