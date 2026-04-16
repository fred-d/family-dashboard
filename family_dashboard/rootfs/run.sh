#!/usr/bin/with-contenv bashio

# Ensure persistent data directories exist
mkdir -p /data/recipes /data/meals /data/grocery /data/photos

bashio::log.info "Starting Family Dashboard on port 8099..."
cd /app
exec python3 server.py
