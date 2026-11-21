RUN apt-get update && apt-get install -y --no-install-recommends {{Packages}} && rm -rf /var/lib/apt/lists/*
