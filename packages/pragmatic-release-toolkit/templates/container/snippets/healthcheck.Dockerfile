HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:{{Scheme}}').request({host:'127.0.0.1',port:{{Port}},path:'/healthz'{{RequestOptions}}},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
