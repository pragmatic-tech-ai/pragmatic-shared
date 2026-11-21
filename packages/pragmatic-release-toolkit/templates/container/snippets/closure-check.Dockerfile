# closure.json, this Dockerfile and the code must agree (package.json `pragmaticClosureCheck`), checked on the very tree
# the image is cut from.
RUN ./node_modules/.bin/pragmatic-closure-check
