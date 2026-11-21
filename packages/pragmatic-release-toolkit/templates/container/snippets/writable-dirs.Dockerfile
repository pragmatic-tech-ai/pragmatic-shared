# The directories the service writes inside its tree (render option WritableDirs): created when missing, owned by the
# service user; what was copied into them, and everything else, stays root's.
RUN mkdir -p {{Dirs}} && chown 10001:10001 {{Dirs}}
