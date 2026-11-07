/* The shared viewer's complete EditorTransport contract over its native host. */
globalThis.PDFStudioNativeTransport = (() => {
  function create(channel, contract) {
    const keys=new Map();
    function abort(signal) {if(signal?.aborted) throw Object.assign(new Error('The request was withdrawn before it was sent.'),{name:'AbortError'});}
    return {
      // Once handed to the worker, retain its answer, including late commit success.
      withdraws:false,
      request(op,params={},options={}) {contract.kind(op);abort(options.signal);return channel.request(op,params,options);},
      resourceKey(op,params) {
        if(contract.kind(op)!=='resource') throw new TypeError('This operation does not produce a resource.');
        const fields=Object.keys(params).sort().map(key=>[key,params[key]]);
        const key=JSON.stringify([op,fields]);
        if(!keys.has(key)) keys.set(key,{op,params:{...params}});
        // Bound unused names during long scrolling sessions. An evicted name is
        // recoverable from its serialized fields, so outstanding keys stay valid.
        if(keys.size>1024) keys.delete(keys.keys().next().value);
        return key;
      },
      async openResource(key,{signal}={}) {
        abort(signal);
        let item=keys.get(key);
        if(!item) {const [op,fields]=JSON.parse(key);if(contract.kind(op)!=='resource')throw new TypeError('Invalid resource operation.');item={op,params:Object.fromEntries(fields)};}
        const data=await channel.request(item.op,item.params,{signal});
        abort(signal);
        if(!data||!['image/png','font/otf','font/ttf'].includes(data.mime)||!Number.isSafeInteger(data.length)||data.length<0||data.length>32*1024*1024||typeof data.base64!=='string'||data.base64.length>Math.ceil(data.length/3)*4) throw new TypeError('Invalid native resource.');
        const raw=atob(data.base64);if(raw.length!==data.length)throw new TypeError('Truncated native resource.');
        const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
        const url=URL.createObjectURL(new Blob([bytes],{type:data.mime}));let released=false;
        return {url,release(){if(!released){released=true;URL.revokeObjectURL(url);}}};
      },
      subscribe(listener){return channel.subscribe(listener);},
    };
  }
  return {create};
})();
