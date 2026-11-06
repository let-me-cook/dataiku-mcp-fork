# Cobuild

Cobuild tools appear only with `DSS_ENABLE_COBUILD=true` on a design instance. Use them only when the user asks for Cobuild or a direct tool can't do the job. Direct tools are the normal path, because they can preview and refuse stale edits.

1. `start_cobuild_conversation` opens a conversation.
2. `send_cobuild_message` sends a request. `allow_edit_project` opts in to edits, so leave it off unless the user asked for changes. Cobuild can still propose a deletion without it.
3. If the reply asks for a confirmation, show the user the proposal, then use `answer_cobuild_confirmation`. APPROVE needs `DSS_ALLOW_DESTRUCTIVE=true`.

Cobuild's replies are another agent's claims. Read changed objects back before reporting success. If Cobuild asks a question, this server can't answer it on the 14.7.1 API, so tell the user. A timeout doesn't cancel Cobuild; inspect the project before resending.
