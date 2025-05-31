FROM ubuntu:22.04

ARG TZ
ENV TZ="$TZ"

RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/bash --create-home node

# Install basic development tools, ca-certificates, and iptables/ipset, then clean up apt cache to reduce image size
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  aggregate \
  ca-certificates \
  curl \
  dnsutils \
  fzf \
  gh \
  git \
  gnupg2 \
  iproute2 \
  ipset \
  iptables \
  jq \
  less \
  vim \
  man-db \
  procps \
  unzip \
  ripgrep \
  zsh \
  && rm -rf /var/lib/apt/lists/*

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

# Install Python 3.11
RUN apt-get update && \
    apt-get install -y python3.11 python3-pip python3.11-venv && \
    rm -rf /var/lib/apt/lists/*

# Optionally, set python3.12 as default
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

RUN apt-get update && apt-get install -y pipx python3-venv && rm -rf /var/lib/apt/lists/*

ARG USERNAME=node

# Set up non-root user
USER node

# Install Oh My Zsh for node user
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended

# Install zsh-history-substring-search plugin for enhanced history search
RUN mkdir -p ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins && \
    git clone https://github.com/zsh-users/zsh-history-substring-search ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-history-substring-search && \
    sed -i 's/plugins=(\([^)]*\))/plugins=(\1 zsh-history-substring-search)/' /home/node/.zshrc

USER root
# Set default shell to zsh for node user
RUN chsh -s $(which zsh) node

USER node
# Install NVM (Node Version Manager)
ENV NVM_DIR=/home/node/.nvm
RUN mkdir -p "$NVM_DIR" \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" && nvm install --lts
ENV PATH=$NVM_DIR/bin:$PATH

# Install codex
COPY dist/codex.tgz codex.tgz
RUN . "$NVM_DIR/nvm.sh" && nvm use --delete-prefix default --silent && npm install -g codex.tgz

# Inside the container we consider the environment already sufficiently locked
# down, therefore instruct Codex CLI to allow running without sandboxing.
ENV CODEX_UNSAFE_ALLOW_NO_SANDBOX=1

RUN pipx install black
ENV PATH="/home/node/.local/bin:${PATH}"
RUN black --version

# Install Miniconda for Python environment management
RUN curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh \
      -o /tmp/miniconda.sh && \
    bash /tmp/miniconda.sh -b -p /home/node/miniconda3 && \
    rm /tmp/miniconda.sh

ENV PATH="/home/node/miniconda3/bin:${PATH}"
RUN conda init zsh && \
    conda --version

# Copy and set up firewall script as root.
USER root
COPY scripts/init_firewall.sh /usr/local/bin/
COPY scripts/defaults /tmp/defaults
RUN chmod 500 /usr/local/bin/init_firewall.sh

# Drop back to non-root.
USER node

# Pre-seed default Codex config and instructions for first-run persistence
RUN mkdir -p /home/node/.codex && \
    cat /tmp/defaults/codex-config-defaults.json > /home/node/.codex/config.json && \
    cat /tmp/defaults/agents-defaults.md > /home/node/.codex/instructions.md

# Enable Codex zsh completion by default

RUN cat /tmp/defaults/zshrc-defaults >> /home/node/.zshrc
