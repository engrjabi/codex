#!/bin/bash
set -e

# Usage:
#   ./run_in_container.sh [--work_dir directory] "COMMAND"
#
#   Examples:
#     ./run_in_container.sh --work_dir project/code "ls -la"
#     ./run_in_container.sh "echo Hello, world!"

# Default the work directory to WORKSPACE_ROOT_DIR if not provided.
WORK_DIR="${WORKSPACE_ROOT_DIR:-$(pwd)}"
# Default allowed domains - can be overridden with OPENAI_ALLOWED_DOMAINS env var
OPENAI_ALLOWED_DOMAINS="${OPENAI_ALLOWED_DOMAINS:-api.openai.com}"

# Parse optional flag.
if [ "$1" = "--work_dir" ]; then
  if [ -z "$2" ]; then
    echo "Error: --work_dir flag provided but no directory specified."
    exit 1
  fi
  WORK_DIR="$2"
  shift 2
fi

WORK_DIR=$(realpath "$WORK_DIR")

# Prefix for container names (for readability); actual container ID used below
CONTAINER_NAME_PREFIX="codex_$(echo "$WORK_DIR" | sed 's/\//_/g' | sed 's/[^a-zA-Z0-9_-]//g')"

# Define cleanup to remove the container on script exit
cleanup() {
  if [ -n "$container_id" ]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
# Trap EXIT to invoke cleanup regardless of how the script terminates
trap cleanup EXIT

# Ensure a command is provided.
if [ "$#" -eq 0 ]; then
  echo "Usage: $0 [--work_dir directory] \"COMMAND\""
  exit 1
fi

# Check if WORK_DIR is set.
if [ -z "$WORK_DIR" ]; then
  echo "Error: No work directory provided and WORKSPACE_ROOT_DIR is not set."
  exit 1
fi

# Verify that OPENAI_ALLOWED_DOMAINS is not empty
if [ -z "$OPENAI_ALLOWED_DOMAINS" ]; then
  echo "Error: OPENAI_ALLOWED_DOMAINS is empty."
  exit 1
fi

# Note: do not remove existing containers to allow parallel runs

# Run the container with the specified directory mounted at the same path inside the container.
## Run the container with the specified directory mounted; capture its container ID
container_id=$(docker run -d \
  -e COST_INPUT_PER_TOKEN \
  -e COST_OUTPUT_PER_TOKEN \
  -e OPENAI_API_KEY \
  -e GEMINI_API_KEY \
  --cap-add=NET_ADMIN \
  --cap-add=NET_RAW \
  -v "$WORK_DIR:/app$WORK_DIR" \
  codex \
  sleep infinity)

# Write the allowed domains to a file in the container
docker exec --user root "$container_id" bash -c "mkdir -p /etc/codex"
for domain in $OPENAI_ALLOWED_DOMAINS; do
  # Validate domain format to prevent injection
  if [[ ! "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
    echo "Error: Invalid domain format: $domain"
    exit 1
  fi
  echo "$domain" | docker exec --user root -i "$container_id" bash -c "cat >> /etc/codex/allowed_domains.txt"
done

# Set proper permissions on the domains file
docker exec --user root "$container_id" bash -c "chmod 444 /etc/codex/allowed_domains.txt && chown root:root /etc/codex/allowed_domains.txt"

# Initialize the firewall inside the container as root user
docker exec --user root "$container_id" bash -c "/usr/local/bin/init_firewall.sh"

# Remove the firewall script after running it
docker exec --user root "$container_id" bash -c "rm -f /usr/local/bin/init_firewall.sh"

# Execute the provided command in the container, ensuring it runs in the work directory.
# We use a parameterized bash command to safely handle the command and directory.

quoted_args=""
for arg in "$@"; do
  quoted_args+=" $(printf '%q' "$arg")"
done
#docker exec -it "$container_id" bash -c "cd \"/app$WORK_DIR\" && codex --provider gemini --model gemini-2.5-pro-preview-05-06 --full-auto ${quoted_args}"
#docker exec -it "$container_id" bash -c "cd \"/app$WORK_DIR\" && codex --model o4-mini --reasoning medium --full-auto ${quoted_args}"
docker exec -it "$container_id" bash -c "cd \"/app$WORK_DIR\" && codex --model codex-mini-latest --reasoning low --full-auto ${quoted_args}"
