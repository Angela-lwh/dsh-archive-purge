# How a third-party dsh plugin's browser half can invoke its own host logic

Extraction root: `<project-dir>\vendor\<pkg>\dsh\node_modules\@deepseek-ai\<pkg>\...`
(each extract-tree keeps the asar prefix). All line refs are to those extracted files.

Running composition facts (verified, read-only): the live `web` profile is `dsh-base` + `dsh-web-app` bundles
(`C:\Users\example\.dsh\profiles\web\package.json`), and `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`
mounts `typert` (`dsh-typert-registry`), `typert-loader` (`dsh-typert-loader`), `typert-gateway`
(`dsh-api-gateway`); `dsh-web-app/cordis.patch.yml:169-231` mounts `webserver` (`dsh-host-webserver`),
`modules` (`dsh-client-modules`), `connection` (`dsh-client-connection`), `file-upload`, `api-remotes`.
So all three mechanisms below are live in the GUI at `http://127.0.0.1:19387`.

---

## 1. REMOTE RPC MECHANISM

### 1.1 Wire route: unary = `POST /api/<namespace>/<method>` over the shared `/api` prefix; streams = WS `/api/remote.mux`

Client half, `vendor/dsh-client-connection/.../lib/client.js:1209-1239`:

```js
function createWebConnectionRpc(doFetch, openStream) {
  const send = doFetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async call(channel, endpoint, payload, signal) {          // :1212
      assertTarget(channel, endpoint);
      const rpcId = RpcId(randomUuid());
      const message = { type: "client-request", rpcId, method: endpoint, payload };
      const response = await send(`${channel}/${endpoint}`.slice(1), {   // :1221  document-RELATIVE url
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        ...signal === void 0 ? {} : { signal }
      });
      if (!response.ok) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`);
      const full = ... parseConnectionResponse(await response.json());    // :1228
      if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`);
      return full.result;                                                  // :1231 {ok:true,value}|{ok:false,error}
    },
    ...
```

Envelopes (`lib/client.js:1288-1313`, `lib/index.js:503-517`):
request `{type:'client-request',rpcId,method,payload}`; response `{type:'server-response',rpcId,result}` where
`result = {ok:true,value}` | `{ok:false,error:{code,message,details}}`.

Host transport, `vendor/dsh-client-connection/.../lib/index.js`:
- `const API_PATH = "/api"` (`:14`); the plugin's `apply` registers it as a **prefix** route (`:829-843`):
  ```js
  const fetchHandler = connection.createSharedFetchHandler(API_PATH);      // :829
  const route = { kind: "prefix", path: API_PATH, handler: async (req, res) => {
      const admission = connection.admit(req);                             // :834  403 / 401 fence + cookie
      if ("rejection" in admission) { res.writeHead(admission.rejection); ... return }
      await webCtx.waterfall("connection/request", req, res,
        () => bridge(req, res, fetchHandler, maxRequestBodyBytes));        // :840
  }};
  webCtx.effect(() => webCtx.webServer.register(route), "client-connection: /api route");
  ```
- `createSharedFetchHandler(channel)` (`:608-624`): **exact Fetch routes win first**, then the single `/api` interceptor:
  ```js
  const route = this.fetchRoutes.get(pathname);
  if (route?.methods.has(request.method) === true) return route.fetch(request);
  const endpoint = endpointFromPath(channel, pathname);
  const interceptor = this.interceptors.get(channel);
  if (endpoint === void 0 || interceptor === void 0 || !interceptor.matches(endpoint))
      return Promise.resolve(new Response("not found", { status: 404 }));
  return interceptor.fetchHandler.fetch(request);
  ```
- Gateway host owns **the one** `/api` interceptor — `vendor/dsh-api-gateway/.../lib/index.js:623-625`:
  ```js
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.connection.rpc.intercept("/api",
      (endpoint) => this.claimsEndpoint(endpoint),
      (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer));
  });
  ```
  `registerInterceptor` (`lib/index.js:658-671`) rejects anything but `channel === "/api"` and rejects a second one.
- Streams: `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"` (`vendor/dsh-api-gateway/.../lib/index.js:12`), registered via
  `webCtx.webServer.registerUpgrade({path, handler(req, socket, head)})` after `webCtx.connection.admit(req)` (`:631-643`).

### 1.2 What `ctx.remote.workspace.archiveSession(...)` resolves to

`ctx.remote` is the client service `ClientRemote` provided by `@deepseek-ai/dsh-api-gateway/client`
(`vendor/dsh-api-gateway/.../lib/client.js:1636` `async $mount(contribution)`).
`ctx.remote.workspace` is a **Cordis child plugin service named `remote.workspace`**, created on mount:

- `$mount` (`:1636-1646`) → `mountContribution` (`:1662-1683`):
  `const disposeRemote = callerCtx.typert.remotes.register(contribution)` then
  `installNamespace(descriptor.namespace, descriptors)`.
- `createNamespace` (`:1739-1757`) runs `this.ownerCtx.plugin({ name: remoteServiceKey(name),
  apply: (ctx) => { service = new RemoteNamespaceService(ctx, name, ...); installed = installMethods(service, descriptors) } })`
  where `remoteServiceKey = (ns) => \`remote.${ns}\`` (`:2040-2042`).
- The client call path (`:1785-1807`):
  ```js
  const result = await connection.rpc.call("/api", endpoint, { args: prepared.args }, prepared.signal);  // :1792
  ...
  value: descriptor.result.mode === "strict" && descriptor.result.decode !== void 0
      ? descriptor.result.decode(result.value) : result.value                             // :1801
  ```
  with `endpointOf = (d) => `${d.namespace}/${d.method}`` → **`POST /api/workspace/archiveSession`**, payload
  `{args:{request:{sessionId, stopOptional}}}`.
- Consumers use it as `inject = ["remote", "remote.workspace"]`
  (`vendor/dsh-api-workspace-controller/.../lib/client.js:445`; model calls `this.remote.archiveSession({sessionId, stopActivity})`
  at `:133-136`).

Where the method table comes from (host): the generated host artifact
`vendor/dsh-api-workspace-controller/.../lib/typert.host.js` exports
```js
export const TYPERT = { package: '@deepseek-ai/dsh-api-workspace-controller', face: 'host', schemas: [], invocations: [ ... ], model: {...} }
```
with the `workspace/archiveSession` descriptor at `typert.host.js:264-287`:
```js
{ id: '@deepseek-ai/dsh-api-workspace-controller#workspace/archiveSession',
  service: 'workspaceController', namespace: 'workspace', method: 'archiveSession',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json',
    codec: { mode: 'strict', typeSymbol: '.../types#WorkspaceArchiveSessionRequest',
             create: _..._archiveSession_parameter_0$schema } }],   // z.object({sessionId, stopActivity?})
  result:    { mode: 'strict', typeSymbol: '.../types#WorkspaceArchiveValue', create: ... } }
```
`package.json` maps it via `"exports": { "./typert": { "default": "./lib/typert.host.js" } }`.
`@deepseek-ai/dsh-typert-loader` resolves `exports["./typert"]` of every Loader entry, validates the manifest
(`vendor/dsh-typert-loader/.../lib/index.js:80-92`: `manifest.package === pkgName`, `face === "host"`, arrays for
`schemas`, `model.services/events/objects`) and calls `ctx.typert.register(manifest)`
(`vendor/dsh-typert-registry/.../lib/index.js:398-418`).

Host dispatch (`vendor/dsh-api-gateway/.../lib/index.js:962-1003`):
```js
const descriptor = this.resolveDescriptor(request.namespace, request.method, endpoint);
assertExactArguments(request.args, descriptor, endpoint);
const receiver = receiverContext.get(descriptor.service);
if (!isObject(receiver)) throw new TypertGatewayError("gateway/service-unavailable", ...);
validateBinding(receiver, descriptor.service, descriptor.namespace, endpoint);   // requires a visible `typertRemote` binding
...
resolveDescriptor(ns, method, endpoint) {
  const strict = this.ctx.typert.local.get(endpoint);
  if (strict !== void 0) return strict;
  if (this.ctx.typert.local.hasSeen(endpoint)) throw new TypertGatewayError("gateway/definition-unavailable", ...);
  return this.resolveSrcDescriptor(ns, method, endpoint);   // SRC fallback: decorator markers only
}
```

The **client-side descriptor table is not per-package**: the shipped assembly
`vendor/dsh-api-remotes/.../lib/client.js` inlines all 25 generated `TYPERT_REMOTE` objects and mounts them:
```js
const inject = ["remote"];                                  // :13503
for (const contribution of [TYPERT_REMOTE$24, ..., TYPERT_REMOTE$22])   // :13512-13537
    disposers.push(await ctx.remote.$mount(contribution));  // :13538
```
(`@deepseek-ai/dsh-api-remotes` is a Loader row in `dsh-web-app/cordis.patch.yml:230-231`.)

### 1.3 Can a THIRD-PARTY plugin declare its own Remote namespace with a plain-JS host half?

**Yes technically, no codegen is strictly mandatory — but only by hand-writing the generated artifacts, and the
generator itself is not shipped in this install** (`@deepseek-ai/dsh-typert-generator` is absent from the asar
package list). The sanctioned route is codegen; the hand-written route is explicitly documented as supported.

Evidence that hand-writing is legitimate — `vendor/dsh-typert-loader/.../lib/index.js:27-29` (module JSDoc):
> `Manual ctx.typert.register() remains available for contributions that do not use a ./typert artifact (hand-written wire schemas, tests, non-loader compositions).`

What a plugin must ship for its own typed namespace, **without** the generator:

Host (Node, plain JS/ESM; no build step needed):
1. A Cordis `Service` carrying a Remote binding — `vendor/dsh-typert-protocol/.../lib/index.js`:
   ```js
   class TypertRemoteService extends Service { constructor(ctx, serviceKey, options = {}) {
     super(ctx, serviceKey); this.typertRemote = bindTypertRemote(this, this.name, options) } }        // :159-172
   function bindTypertRemote(service, serviceKey, options = {}) { ... }                                 // :146-157
   ```
   The binding is mandatory even on the strict path: `validateBinding` throws
   `gateway/binding-invalid` when `Reflect.get(original,"typertRemote")` is `undefined`
   (`vendor/dsh-api-gateway/.../lib/index.js:1450-1461`, called at `:969`).
2. Hand-written strict descriptors registered directly (path A) `ctx.typert.register({...})`
   (`vendor/dsh-typert-registry/.../lib/index.js:398-418`) with `{package, face:'host', schemas, invocations, model}`;
   or (path B) a `"./typert"` export whose `TYPERT` manifest the loader picks up (then `model` and the full
   manifest shape are additionally validated: `typert-loader/lib/index.js:77-116`).
   Per-descriptor required shape (`typert-registry/lib/index.js:522-566`, `typert-loader/lib/index.js:155-211`):
   `{ id, service, namespace, method, invocation:{kind:'direct'|'context'}, parameters:[{name, wire, source:'json'|'lookup',
   codec:{mode:'strict', typeSymbol, create}}], cancellation?:{parameter:'signal'}, mode?:'stream', result:{mode:'strict',
   typeSymbol, create}, sourceLocation?:{file,line,column} }` — every strict codec needs a `create()` factory returning a
   Zod schema (the `dsh-api-*` packages import `zod` for this).
   Endpoint grammar: `namespace`/`method`/wire names must match `/^[A-Za-z0-9_$.-]+$/` and cannot be `.`/`..`
   (`typert-registry/lib/index.js:567-575`).
Client (browser):
3. A client bundle at `exports["./client"]` (`dsh-client-modules` requires it whenever `dsh.client.platform === "web"`:
   `vendor/dsh-client-modules/.../lib/index.js:713-720`), whose file content must self-register into the page's lazy-CJS
   table: `window.__ModuleLoader__.load({ id: '<package-name>', factory: (require) => ({ name, inject, apply }) })`
   (registration contract: `dsh-client-modules/lib/client.js:563-581`; the file is served **verbatim** as a combo script,
   `dsh-client-modules/lib/index.js:330-334`).
4. The bundle must mount its own contribution: `await ctx.remote.$mount({ package: '<pkg>', descriptors: [...] })`.
   `validateContribution` (`dsh-api-gateway/lib/client.js:1684-1709`) → `requireStrictInputs` (`:2069-2075`) rejects any
   parameter/uplink/context codec whose `codec.mode !== "strict"`; the **result** codec is optional
   (`decode` used only when `result.mode === 'strict' && result.decode !== undefined`, `:1801`). The package name must
   differ from every already-mounted contribution (`typert-registry/lib/index.js:143`).

Practical consequences: this is two hand-maintained descriptor tables (host strict codecs with zod + client mirror)
plus a `remote.<namespace>` service namespace that must not collide (`dsh-api-gateway/lib/client.js:1703-1707`).
A simpler SRC escape hatch exists host-side (`gateway/invocation-unavailable`-free) but still needs the `@Remote`
prototype marker (`typert-protocol/lib/index.js:183-227`; plain-JS decorators require a transpiler, or writing the
internal string-keyed prototype descriptor `"@deepseek-ai/dsh-typert-protocol/remote-methods"` by hand) **and** every
client call then still has to go through `ctx.connection.rpc.call('/api', '<ns>/<method>', {args})` because no client
descriptor exists to mount.

### 1.4 The simpler documented alternative for one host function

`@deepseek-ai/dsh-client-connection` exposes a **generic, carrier-neutral RPC registry** to any host plugin and the
matching browser caller to any client plugin — no Typert, no descriptors, no generator:

```js
// host, vendor/dsh-client-connection/.../lib/index.js:573-579
get rpc() {
  const owner = this.ctx;
  return {
    handle:    (channel, handler) => this.register(owner, channel, handler),
    intercept: (channel, matches, handler) => this.registerInterceptor(owner, channel, matches, handler)
  };
}
```
```js
// register() :640-657 — registers a webserver PREFIX route at exactly `channel`
register(owner, channel, handler) {
  assertChannel(channel);
  const fetchHandler = rpcFetchHandler(channel, handler, this.operator);
  const route = { kind: "prefix", path: channel, handler: async (req, res) => {
      const admission = this.admit(req);
      if ("rejection" in admission) { res.writeHead(admission.rejection); res.end(...); return }
      await bridge(req, res, fetchHandler);
  }};
  return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);
}
```
```js
// rpcFetchHandler() :673-702 — the handler contract
async fetch(request) {
  const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
  if (request.method !== "POST" || endpoint === void 0) return new Response("not found", { status: 404 });
  if (request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase() !== "application/json")
      return new Response("content type must be application/json", { status: 415 });
  const body = await request.json();                     // :682
  const envelope = clientRequestSchema.safeParse(body);   // {type:'client-request',rpcId,method,payload}
  if (message.method !== endpoint) return errorResponse(...gateway/bad-request...);
  const result = await handler(endpoint, message.payload, request.signal, peer);   // :695
  return fullResponse(message.rpcId, result);            // expects {ok:true,value} | {ok:false,error:{...}}
}
```
Grammar: `CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`, `ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`
(`lib/index.js:549-550`), `assertChannel` forbids `/api` (`:755-757`). Registration is scoped to the reading Context:
Cordis's tracker makes `service.ctx` the caller's Context (`dsh/node_modules/@deepseek-ai/cordis/src/utils.ts`,
`createTraceable` → `if (prop === tracker.property) return ctx`), which is what the JSDoc "scoped to the Context reading
this service" means.

Second, equally simple alternative — **exact Fetch routes** on the same authenticated `/api` seat
(`get fetch()` `lib/index.js:581-584`, `registerFetchRoute` `:625-639`, `assertFetchRoute` `:758-762`):
```js
ctx.connection.fetch.register({
  path: '/api/<seg>/<seg>',       // must be under /api/, segments /^[A-Za-z0-9_$.-]+$/
  methods: ['POST'],               // non-empty, no duplicates
  requestBody: 'buffered',         // or 'streaming'
  fetch: (request) => Promise<Response>   // WHATWG Request → Response; body via await request.json()
})
```
Real first-party precedent: `vendor/dsh-client-file-upload/.../lib/index.js:73` `const FILE_UPLOAD_PATH = "/api/session/uploadFileBinary";`
and `:171-176`:
```js
ctx.effect(() => ctx.connection.fetch.register({
  path: FILE_UPLOAD_PATH, methods: ["POST"], requestBody: "streaming",
  fetch: (request) => handleFileUploadHttp(this, request)
}), "file-upload: streaming route");
```
Its browser half calls the document-relative form with credentials: `lib/client.js:62`
`const FILE_UPLOAD_ROUTE = "/api/session/uploadFileBinary".slice(1);` and `:133-139` `doFetch(request.url, { method:"POST", ..., credentials: "include" })`.

---

## 2. HTTP ROUTE OPTION

### 2.1 `ctx.webServer.register(route)` — exact contract

`vendor/dsh-host-webserver/.../lib/index.js`:
```js
register(route) {                                             // :177
  const table = route.kind === "exact" ? this.exact : this.prefixes;
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
  table.set(route.path, route);
  return () => { table.delete(route.path); };
}
registerUpgrade(route) { ... route = {path, handler(req, socket, head)} }   // :191-197, dispatched :261-294
registerFallback(handler) { if (this.fallback !== void 0) throw new Error("webserver: fallback already registered"); ... }  // :206-212
tapIndex(transform)                                        // :220-226
```
`WebRoute` (the type is not shipped as `.d.ts`; the runtime contract is exact): `kind: 'exact' | 'prefix'`,
`path: string` (pathname only), `handler: (req: node:http IncomingMessage, res: node:http ServerResponse) => void | Promise<void>`.
Dispatch (`:229-245`): `const route = this.match(rawPath); if (route !== void 0) { await route.handler(req, res); return }`
then the fallback, else `404`. Matching (`:322-332`): exact table first, then **longest prefix** where
`pathname === prefix || pathname.startsWith(prefix + '/')`, then fallback. A handler that throws is answered `400`
(or the socket destroyed if headers were already sent) and logged as a warning (`:246-259`).
There is **no** body parser, no JSON helper, and **no path namespacing**: the registered path is the whole namespace, and
a collision is a hard activation error. Response ownership (status, headers, body) is entirely the handler's.
Gzip wrapping is optional composition config (`compression: 'gzip'`, `:106-131`).

### 2.2 AUTH

`vendor/dsh-client-connection/.../lib/index.js`:
```js
requestRejection(request) {                                  // :586-589
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
  return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
}
admit(request) {                                             // :591-594
  const rejection = this.requestRejection(request);
  return rejection === void 0 ? { peer: this.operator } : { rejection };
}
authorizeIndex(request, response) { return this.browserAuth.authorizeIndex(request, response); }   // :596-598
authenticatedUrl(baseUrl) { return this.browserAuth.authenticatedUrl(baseUrl); }                   // :600-602
```
- `isTrustedApiRequest` (`:205-219`): `Host` must be loopback (`isLoopbackHostname`, `:121-125`) or a configured
  `trustedHosts` authority; `sec-fetch-site: cross-site` refused; if `Origin` is present it must equal `Host`
  (`new URL(origin).host === hostUrl.host`).
- `BrowserAuth.authorizeIndex` (`:388-427`): only `GET /` with exactly one `?token=` matching the process launch token
  mints the signed cookie and `303` → `location: "./"`; otherwise `isAuthenticated(req)` lets an existing cookie serve
  the index; anything else gets the minimal `401` (`:444-450`).
- `BrowserAuth.isAuthenticated` (`:433-443`): reads cookie `dsh-auth-<base64url(sha256(authority))>` (`:284-286`),
  verifies HMAC with the `client-connection/browser-session` credential (`:223`, `:299-324`), requires
  `payload.authority === authority` and an unexpired issued/expiry interval.
- Cookie attributes (`:296-298`): `Max-Age=…; Path=/; HttpOnly; SameSite=Strict` — deliberately **no** `Secure`
  (loopback HTTP). Host-only, `Path=/`.
- `authenticatedUrl` (`:374-378`) only appends `?token=`; it is used by `dsh-web-app` for the printed/opened URL
  (`vendor/dsh-web-app/.../lib/index.js:198-203`).

**Would a browser `fetch('/my-route')` from the GUI page already carry authorization?**
It carries the cookie automatically (same-origin request → default `credentials: "same-origin"` sends the host-only
`Path=/` cookie; the first-party upload worker passes `credentials: "include"` explicitly,
`vendor/dsh-client-file-upload/.../lib/client.js:136`). **But the cookie is only *checked* where `admit()` runs**:
the `/api` prefix route (`dsh-client-connection/lib/index.js:833-843`), the gateway mux upgrade
(`dsh-api-gateway/lib/index.js:633-639`), and index responses via `frontend-static`
(`vendor/dsh-host-frontend-static/.../lib/index.js:60,95`). Therefore:
- A route registered with **`ctx.connection.fetch.register({path:'/api/...'})` is authenticated for free** — it is
  dispatched *inside* the `/api` handler after `admit()` (`createSharedFetchHandler`, `lib/index.js:608-624`, reached at
  `:840`), and it wins over the Gateway interceptor.
- A route registered with **`ctx.webServer.register({kind:'exact', path:'/my-route'})` is NOT authenticated**;
  `dsh-host-webserver` "carries no TLS, authentication, or origin policy of its own" (README:113). Such a handler must
  call `ctx.connection.admit(req)` (or `ctx.connection.requestRejection(req)`) itself; otherwise any local process — and
  a cross-site POST that survives a simple-request CORS preflight — reaches it.

### 2.3 Base path / mount prefix, and `registerFallback`

- **No configurable mount prefix in the shipped Web composition.** `frontend-static` (the fallback owner) serves the
  dist at the root and injects `<base href="./">` into `index.html`
  (`vendor/dsh-host-frontend-static/.../lib/index.js:85`), and `authorizeIndex`'s root-token exchange requires
  `url.pathname === "/"` (`dsh-client-connection/lib/index.js:394`). The application is therefore mounted at `/`
  here; a deployment under a subdirectory would still work because app-facing URLs are deliberately
  **document-relative**: `dsh-client-modules` strips the leading slash from every app route
  (`vendor/dsh-client-modules/.../lib/index.js:210-218`), `ClientConnection.rpc.call` does `...slice(1)` (`:1221`), and
  file-upload's client does `"/api/session/uploadFileBinary".slice(1)` (`dsh-client-file-upload/lib/client.js:62`).
  A plugin route under `/api/...` should use the same document-relative form (or an absolute `/api/...` given the
  root mount) and must not rely on `<base>` semantics for the server-side path.
- **`registerFallback` exists** (`dsh-host-webserver/lib/index.js:206-212`): one seat only, second registration throws,
  no fallback → `404`. The shipped owner is `frontend-static` (`lib/index.js:87-96`). A plugin must not try to claim it.
- Route ownership in the running composition: prefix `/api` → `dsh-client-connection`; prefix `/plugins` →
  `dsh-client-modules` (`PLUGIN_ROUTE`, `lib/index.js:201`); upgrade `/api/remote.mux` → `dsh-api-gateway`;
  everything else → SPA fallback. Exact routes beat prefixes globally, so a plugin's `/api/<its-own-segment>/...`
  exact Fetch route cannot be shadowed (but must not duplicate an existing exact path — `:633` throws).

---

## 3. RECOMMENDATION: which is less code and less fragile

**Use `ctx.connection.rpc.handle()` (option 1.4) for a single host operation. Runner-up: `ctx.connection.fetch.register()`.**

Fragility ranking for "one host operation (delete a session by id)" on the authenticated `/api` seat:

| Approach | Host code | Client code | Moving parts / failure modes |
|---|---|---|---|
| `ctx.connection.rpc.handle('/<id>', handler)` | ~12 lines | ~4 lines | None beyond Connection+webServer. Own envelope contract. Call **rejects** (does not fold) on transport failure. |
| `ctx.connection.fetch.register({path:'/api/<id>/…'})` | ~12 lines | ~6 lines | Same gate; you own HTTP status/shape. Wins over the Gateway interceptor. First-party precedent (`dsh-client-file-upload`). |
| Typed Remote (`ctx.remote.<ns>`) | hand-written strict descriptor table + `TypertRemoteService` binding + `ctx.typert.register`; if using `./typert`, a full validated manifest with `model` | hand-written mirror descriptor table + `window.__ModuleLoader__.load` bundle + `ctx.remote.$mount` | zod factories, endpoint/service/namespace uniqueness, `assertExactArguments` (extra/missing fields rejected), binding check (`gateway/binding-invalid`), withdrawal → `gateway/definition-unavailable`, generator not shipped, duplicates `dsh-api-remotes`' assembly role. **Most code, most moving parts.** |

Why not the typed path: the generator (`@deepseek-ai/dsh-typert-generator`) is not part of the install, so the only
"supported" way to author it is by hand; and even hand-written it assumes the plugin maintains two descriptor tables
plus a Cordis Service binding, all validated by four different packages.

### Minimal host half (`<pkg>/index.js`, plain ESM, no build step)

```js
/** dsh-archive-purge — host half. */
export const name = 'dsh-archive-purge'
export const inject = ['connection']          // hard wait: the web RPC carrier must exist

export function apply(ctx) {
  // Channel grammar: /^\/[A-Za-z0-9._~-]+$/ and must not be '/api'.
  ctx.connection.rpc.handle('/dsh-archive-purge',
    async (endpoint, payload, signal, peer) => {
      if (endpoint !== 'deleteSession') {
        return { ok: false, error: { code: 'archive-purge/unknown-endpoint',
                                     message: `unknown endpoint ${endpoint}`, details: {} } }
      }
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, error: { code: 'archive-purge/bad-request',
                                     message: 'sessionId must be a non-empty string', details: {} } }
      }
      try {
        await deleteSessionById(sessionId, signal)          // the plugin's own host logic
        return { ok: true, value: { deleted: true } }
      } catch (error) {
        return { ok: false, error: { code: 'archive-purge/failed',
                                     message: String(error?.message ?? error), details: {} } }
      }
    })
}
```
Notes: the return value **must** be `{ok:true,value}` or `{ok:false,error:{code,message,details}}`; a thrown error
becomes `HTTP 500 "handler failure: …"` and the browser caller rejects. `payload` is exactly the object the browser
passed; `signal` aborts on client disconnect; `peer` is `ctx.connection.operator`. The call returns a disposer;
wrap with `ctx.effect` if the plugin may reload.

### Minimal browser half (`<pkg>/client.js`, served from `exports["./client"]`)

```js
window.__ModuleLoader__.load({
  id: 'dsh-archive-purge',                       // must equal the package name (boot graph row id)
  factory: (require) => {
    const name = 'archive-purge'
    const inject = ['connection']                // Cordis service wait; connection is provided at page boot
    function apply(ctx) {
      ctx.effect(() => {
        const deleteSession = async (sessionId) => {
          const result = await ctx.connection.rpc.call('/dsh-archive-purge', 'deleteSession', { sessionId })
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          return result.value                       // { deleted: true }
        }
        registerDeleteAffordance(deleteSession)      // the plugin's own UI hook
        return () => {}
      }, 'archive-purge: delete affordance')
    }
    return { name, inject, apply }
  }
})
```
`ctx.connection.rpc.call` posts the document-relative `dsh-archive-purge/deleteSession` with
`content-type: application/json` and the browser cookie; the host `/api`-style admission is not involved for a
non-`/api` channel — `connection.rpc.handle` calls `this.admit(req)` itself in the registered prefix route
(`dsh-client-connection/lib/index.js:646-653`), so **403/401 apply to this channel too**.

### package.json additions

```json
{
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection"] },
    "bundle":   { "patch": "./cordis.patch.yml" }
  }
}
```
`dsh.client.platform === "web"` + `exports["./client"]` are the two hard requirements for the browser half
(`dsh-client-modules/lib/index.js:713-720`); a missing bundle fails activation loudly. `dsh.client.inject` lists
**package names** to preload as boot-graph rows (`dsh-client-modules/lib/client.js:656`), while the bundle's exported
`inject: ['connection']` is the Cordis **service** wait (`dsh-client-connection/lib/client.js:1477`
`ctx.provide("connection", handle)`). Ship the Loader row through a bundle patch exactly like the existing third-party
plugin `dsh-engramory` (`package.json` `dsh.bundle.patch: "./cordis.patch.yml"`, patch body
`- insert: [{ id: <row-id>, name: <pkg>, config: {...} }]`).

### If you prefer a raw browser `fetch` shape instead of the RPC envelope

Swap the host half for:
```js
export const inject = ['connection']
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-archive-purge/deleteSession',   // must be under /api/, segments /^[A-Za-z0-9_$.-]+$/
    methods: ['POST'],
    requestBody: 'buffered',                        // or 'streaming' (then request.body is a ReadableStream)
    fetch: async (request) => {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const { sessionId } = await request.json()
      if (typeof sessionId !== 'string') return Response.json({ error: 'sessionId required' }, { status: 400 })
      await deleteSessionById(sessionId, request.signal)
      return Response.json({ deleted: true })
    }
  }), 'archive-purge: delete route')
}
```
and the browser half:
```js
const response = await fetch('/api/dsh-archive-purge/deleteSession'.slice(1), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId }), credentials: 'include'
})
```
This is byte-for-byte the `dsh-client-file-upload` pattern and is authenticated by the `/api` `admit()` gate.

### Security caveat for whichever route you pick

Do **not** register the delete operation as a bare `ctx.webServer.register({kind:'exact', path:'/delete-session'})`:
that seat has no authentication, so any local process (and any web page that can reach loopback) could delete sessions.
`ctx.connection.rpc.handle` and `ctx.connection.fetch.register` both inherit the Host/Origin fence (403) plus the
signed browser cookie (401).
