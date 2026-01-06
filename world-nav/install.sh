#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Install rustup if not present
if ! command -v rustup &>/dev/null; then
  echo "Installing rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # Source cargo env for current session only
  source "$HOME/.cargo/env"
fi

# Install the toolchain specified in rust-toolchain.toml
# This will read rust-toolchain.toml and install the correct version
echo "Installing toolchain from rust-toolchain.toml..."
rustup show
cargo --version
rustc --version

# Clean build artifacts
#echo "Cleaning build artifacts..."
#cargo clean

# Run formatter check
echo -e "${YELLOW}Running formatter check...${NC}"
if ! cargo fmt -- --check; then
  echo -e "${RED}Formatting issues detected!${NC}"
  echo "Run 'cargo fmt' to fix formatting issues"
  exit 1
fi
echo -e "${GREEN}✓ Format check passed${NC}"

# Run linter
echo -e "${YELLOW}Running linter (clippy)...${NC}"
if ! cargo clippy -- -D warnings; then
  echo -e "${RED}Linter warnings/errors detected!${NC}"
  echo "Fix the issues reported by clippy before installing"
  exit 1
fi
echo -e "${GREEN}✓ Linter check passed${NC}"

# Run tests
echo -e "${YELLOW}Running tests...${NC}"
if ! cargo test; then
  echo -e "${RED}Tests failed!${NC}"
  echo "Fix failing tests before installing"
  exit 1
fi
echo -e "${GREEN}✓ Tests passed${NC}"

# Build the project
# echo -e "${YELLOW}Building project...${NC}"
# cargo build --release
# echo -e "${GREEN}✓ Build successful${NC}"

# Install the binary to cargo bin directory
echo -e "${YELLOW}Installing world-nav...${NC}"
cargo install --path . --force

echo -e "${GREEN}Installation complete!${NC}"
echo "Binary installed to: $(which world-nav || echo "$HOME/.cargo/bin/world-nav")"
