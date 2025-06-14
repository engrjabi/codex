#!/bin/bash
# Exit immediately if a command exits with a non-zero status.
set -e

# Load environment variables from .env in the current directory if it exists
if [ -f .env ]; then
  echo "Loading environment variables from .env"
  set -o allexport
  source .env
  set +o allexport
fi

# Print helper message about expected environment variables on each run
cat << 'EOF'
Environment variables:

Required:
  DMS_LITE_LLM_API_KEY         Lite LLM API key for the sandbox environment.

Optional:
  OPENAI_ALLOWED_DOMAINS       Space-separated list of allowed domains (default: api.openai.com).
  DOCKER_IMAGE                 Docker image to use (default: codex).
  WORKSPACE_ROOT_DIR           Default work directory (default: current directory).
EOF
echo ""

# Required environment variables:
#   DMS_LITE_LLM_API_KEY         OpenAI API key for the sandbox environment.
#
# Optional environment variables:
#   OPENAI_ALLOWED_DOMAINS       Space-separated list of allowed domains (default: api.openai.com).
#   DOCKER_IMAGE                 Docker image to use (default: codex).
#   WORKSPACE_ROOT_DIR           Default work directory (default: current directory).

# Check for required environment variables
REQUIRED_ENVS=(DMS_LITE_LLM_API_KEY)
missing_envs=()
for var in "${REQUIRED_ENVS[@]}"; do
  if [ -z "${!var}" ]; then
    missing_envs+=("$var")
  fi
done
if [ ${#missing_envs[@]} -gt 0 ]; then
  echo "Error: Missing required environment variables: ${missing_envs[*]}"
  exit 1
fi

# Docker image to use; override with DOCKER_IMAGE env var. Defaults to 'codex'.
DOCKER_IMAGE="${DOCKER_IMAGE:-codex}"

# Usage:
#   DOCKER_IMAGE=<docker/image:tag> ./run_in_container.sh [--work_dir directory] "COMMAND"
#
# Examples:
#   DOCKER_IMAGE=myrepo/codex:latest ./run_in_container.sh --work_dir project/code "ls -la"
#   DOCKER_IMAGE=myrepo/codex:latest ./run_in_container.sh "echo Hello, world!"

# Default the work directory to WORKSPACE_ROOT_DIR if not provided.
WORK_DIR="${WORKSPACE_ROOT_DIR:-$(pwd)}"
# Default allowed domains - can be overridden with OPENAI_ALLOWED_DOMAINS env var
OPENAI_ALLOWED_DOMAINS="${OPENAI_ALLOWED_DOMAINS:-api.openai.com}"

# Parse optional flag.
#if [ "$1" = "--work_dir" ]; then
#  if [ -z "$2" ]; then
#    echo "Error: --work_dir flag provided but no directory specified."
#    exit 1
#  fi
#  WORK_DIR="$2"
#  shift 2
#fi

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
#if [ "$#" -eq 0 ]; then
#  echo "Usage: $0 [--work_dir directory] "COMMAND""
#  exit 1
#fi

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

# Setup a persistent home directory volume for this project to cache shared packages (Miniconda, NVM, npm)
WORK_DIR_SAFE="${CONTAINER_NAME_PREFIX#codex_}"
HOME_VOLUME="codex_home_${WORK_DIR_SAFE}"
# Handle subcommands: clear removes the volume, start runs alias cx
START_MODE=false
if [ "$1" = "start" ]; then
  START_MODE=true
  shift
fi
if [ "$1" = "clear" ]; then
  # Remove any containers using this volume, then delete the volume
  if ! docker volume inspect "$HOME_VOLUME" >/dev/null 2>&1; then
    echo "Volume $HOME_VOLUME does not exist"
    exit 0
  fi
  # Find containers using the volume
  using=$(docker ps -aq --filter volume=$HOME_VOLUME)
  if [ -n "$using" ]; then
    echo "Stopping and removing containers using volume $HOME_VOLUME: $using"
    docker rm -f $using >/dev/null 2>&1 || true
  fi
  echo "Removing volume $HOME_VOLUME"
  docker volume rm "$HOME_VOLUME"
  exit 0
fi
if ! docker volume inspect "$HOME_VOLUME" >/dev/null 2>&1; then
  docker volume create "$HOME_VOLUME"
fi
DOCKER_USER_MOUNTS=( -v "${HOME_VOLUME}:/home/node" )

# Note: do not remove existing containers to allow parallel runs

# Run the container with the specified directory mounted at the same path inside the container.
## Run the container with the specified directory mounted; capture its container ID
container_id=$(docker run -d \
  -e OPENAI_BASE_URL="http://172.17.0.1:4000/v1" \
  -e OPENAI_API_KEY="$DMS_LITE_LLM_API_KEY" \
  -e DMS_LITE_LLM_API_KEY \
  --cap-add=NET_ADMIN \
  --cap-add=NET_RAW \
  -v "$WORK_DIR:/app$WORK_DIR" \
  "${DOCKER_USER_MOUNTS[@]}" \
  "${DOCKER_IMAGE}" \
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

# Launch using alias cx if start subcommand was used
if [ "$START_MODE" = true ]; then
  docker exec -it -w "/app$WORK_DIR" "$container_id" zsh -ic "cx"
fi
# Launch an interactive zsh shell in the work directory inside the container.
docker exec -it -w "/app$WORK_DIR" "$container_id" zsh
