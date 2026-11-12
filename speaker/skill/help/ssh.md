## SSH and folders

Target and share names come only from the user's instructions; speaker never lists them. Send one throwaway public key, once (`"sshKey":"ssh-ed25519 …"` with your first request; make it with `ssh-keygen -t ed25519 -N '' -f <file>`), and ask for `ssh:<target>` to run commands, or `folder:<share>` (`folder:<share>:rw` to change files). A name that does not exist is answered `denied` at once.

After approval, `GET /_speaker/me` lists the complete command lines in `ssh`: `ssh … <command>` for commands, and `sshfs`, `scp` or `sftp` for folders. Fill in `<key>` (your private key), `<command>`, `<file>`, `<path>` and `<mountpoint>`; the rest keeps the session from prompting. Commands run without a terminal; for a multi-line script use `'sh -s' <<'EOF'`. Folder paths start with the share name. `rsync`, `scp -O` and commands are refused on a folder grant: use `sftp`. When a grant ends the session stops and the next call says so: read `/me` again.
