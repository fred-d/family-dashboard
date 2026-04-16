ARG BUILD_FROM
FROM $BUILD_FROM

# Install Python 3 and pip
RUN apk add --no-cache python3 py3-pip

# Copy and install Python dependencies first (layer cache friendly)
COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/requirements.txt

# Copy the entire rootfs into the container
COPY rootfs /

# Make the startup script executable
RUN chmod a+x /run.sh

CMD ["/run.sh"]
