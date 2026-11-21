COPY --from=build --chown=10001:10001 /workspace/{{App}}/{{Path}} /workspace/{{App}}/{{Path}}
