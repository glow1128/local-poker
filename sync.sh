#!/bin/bash

LOCAL_DIR="/Users/mark/Workspace/code/github/local-poker"
REMOTE_HOST="dev"
REMOTE_DIR="/opt/code/local-poker"

rsync -avh --progress --exclude-from=.gitignore -e ssh "$LOCAL_DIR/" "$REMOTE_HOST:$REMOTE_DIR/"
