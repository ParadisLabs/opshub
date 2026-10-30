// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/buffer.js
var bufferToFormData = (arrayBuffer, contentType) => {
  return new Response(arrayBuffer, { headers: { "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase()) } }).formData();
};

// node_modules/hono/dist/utils/body.js
var MAX_NESTED_OBJECTS = 1e4;
var isRawRequest = (request) => "headers" in request;
var parseBody = async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const mediaType = (isRawRequest(request) ? request.headers : request.raw.headers).get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") return parseFormData(request, {
    all,
    dot
  });
  return {};
};
async function parseFormData(request, options) {
  if (!isRawRequest(request) && request.bodyCache.formData) return convertFormDataToBodyData(await request.bodyCache.formData, options);
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const arrayBuffer = await request.arrayBuffer();
  const formDataPromise = bufferToFormData(arrayBuffer, headers.get("Content-Type") || "");
  if (!isRawRequest(request)) request.bodyCache.formData = formDataPromise;
  const formData = await formDataPromise;
  if (formData) return convertFormDataToBodyData(formData, options);
  return {};
}
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  const nestingState = { count: 0 };
  formData.forEach((value, key) => {
    if (!(options.all || key.endsWith("[]"))) form[key] = value;
    else handleParsingAllValues(form, key, value);
  });
  if (options.dot) Object.entries(form).forEach(([key, value]) => {
    if (key.includes(".")) {
      handleParsingNestedValues(form, key, value, nestingState);
      delete form[key];
    }
  });
  return form;
}
var handleParsingAllValues = (form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) form[key].push(value);
    else form[key] = [form[key], value];
  } else if (!key.endsWith("[]")) form[key] = value;
  else form[key] = [value];
};
var handleParsingNestedValues = (form, key, value, state) => {
  if (/(?:^|\.)__proto__\./.test(key)) return;
  let nestedForm = form;
  const keys = key.split(".", 34);
  if (keys.length > 33) throwNestingLimitExceeded();
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) nestedForm[key2] = value;
    else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        if (state.count++ >= MAX_NESTED_OBJECTS) throwNestingLimitExceeded();
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};
var throwNestingLimitExceeded = () => {
  throw new Error("Nesting limit exceeded");
};

// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
  const paths = path.split("/");
  if (paths[0] === "") paths.shift();
  return paths;
};
var splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
};
var extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return {
    groups,
    path
  };
};
var replaceGroupMarks = (paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) if (paths[j].includes(mark)) {
      paths[j] = paths[j].replace(mark, groups[i][1]);
      break;
    }
  }
  return paths;
};
var patternCache = {};
var getPattern = (label, next) => {
  if (label === "*") return "*";
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [
        cacheKey,
        match2[1],
        new RegExp(`^${match2[2]}(?=/${next})`)
      ] : [
        label,
        match2[1],
        new RegExp(`^${match2[2]}$`)
      ];
      else patternCache[cacheKey] = [
        label,
        match2[1],
        true
      ];
    }
    return patternCache[cacheKey];
  }
  return null;
};
var tryDecode = (str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
};
var tryDecodeURI = (str) => tryDecode(str, decodeURI);
var getPath = (request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) break;
  }
  return url.slice(start, i);
};
var getPathNoStrict = (request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
var mergePath = (base, sub, ...rest) => {
  if (rest.length) sub = mergePath(sub, ...rest);
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) return null;
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) basePath += "/" + segment;
    else if (/\:/.test(segment)) {
      if (segment.charCodeAt(segment.length - 1) === 63) {
        if (results.length === 0 && basePath === "") results.push("/");
        else results.push(basePath);
        const optionalSegment = segment.slice(0, -1);
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else basePath += "/" + segment;
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
};
var tryDecodeURIComponent = (str) => str.indexOf("%") !== -1 ? tryDecode(str, decodeURIComponent_) : str;
var _decodeURI = (value) => {
  if (value.indexOf("+") !== -1) value = value.replace(/\+/g, " ");
  return tryDecodeURIComponent(value);
};
var _getQueryParam = (url, key, multiple) => {
  const hashIndex = url.indexOf("#", 8);
  if (hashIndex !== -1) url = url.slice(0, hashIndex);
  let encoded;
  if (!multiple && key && key.indexOf("%") === -1 && key.indexOf("+") === -1) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) return;
    if (!url.startsWith(key, keyIndex2 + 1)) keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) return "";
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) return;
  }
  const results = /* @__PURE__ */ Object.create(null);
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) valueIndex = -1;
    let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex);
    if (encoded) name = _decodeURI(name);
    keyIndex = nextKeyIndex;
    if (name === "") continue;
    let value;
    if (valueIndex === -1) value = "";
    else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) value = _decodeURI(value);
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) results[name] = [];
      results[name].push(value);
    } else results[name] ??= value;
  }
  return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var HonoRequest = class {
  /**
  * `.raw` can get the raw Request object.
  *
  * @see {@link https://hono.dev/docs/api/request#raw}
  *
  * @example
  * ```ts
  * // For Cloudflare Workers
  * app.post('/', async (c) => {
  *   const metadata = c.req.raw.cf?.hostMetadata?
  *   ...
  * })
  * ```
  */
  raw;
  #validatedData;
  #matchResult;
  routeIndex = 0;
  /**
  * `.path` can get the pathname of the request.
  *
  * @see {@link https://hono.dev/docs/api/request#path}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const pathname = c.req.path // `/about/me`
  * })
  * ```
  */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex]?.[1][key];
    const param = this.#getParamValue(paramKey);
    return param && tryDecodeURIComponent(param);
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex]?.[1] ?? {});
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) decoded[key] = tryDecodeURIComponent(value);
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) return this.raw.headers.get(name) ?? void 0;
    const headerData = /* @__PURE__ */ Object.create(null);
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) return cachedBody;
    for (const anyCachedKey in bodyCache) return bodyCache[anyCachedKey].then((body) => {
      if (anyCachedKey === "json") body = JSON.stringify(body);
      const contentType = anyCachedKey === "formData" ? void 0 : raw2.headers.get("content-type");
      return new Response(body, { headers: contentType ? { "Content-Type": contentType } : void 0 })[key]();
    });
    return bodyCache[key] = raw2[key]();
  };
  /**
  * `.json()` can parse Request body of type `application/json`
  *
  * @see {@link https://hono.dev/docs/api/request#json}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.json()
  * })
  * ```
  */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
  * `.text()` can parse Request body of type `text/plain`
  *
  * @see {@link https://hono.dev/docs/api/request#text}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.text()
  * })
  * ```
  */
  text() {
    return this.#cachedBody("text");
  }
  /**
  * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
  *
  * @see {@link https://hono.dev/docs/api/request#arraybuffer}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.arrayBuffer()
  * })
  * ```
  */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
  * `.bytes()` parses the request body as a `Uint8Array`.
  *
  * @see {@link https://hono.dev/docs/api/request#bytes}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.bytes()
  * })
  * ```
  */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
  * Parses the request body as a `Blob`.
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.blob();
  * });
  * ```
  * @see https://hono.dev/docs/api/request#blob
  */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
  * Parses the request body as `FormData`.
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.formData();
  * });
  * ```
  * @see https://hono.dev/docs/api/request#formdata
  */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
  * Adds validated data to the request.
  *
  * @param target - The target of the validation.
  * @param data - The validated data to add.
  */
  addValidatedData(target, data) {
    (this.#validatedData ??= {})[target] = data;
  }
  valid(target) {
    return this.#validatedData?.[target];
  }
  /**
  * `.url` can get the request url strings.
  *
  * @see {@link https://hono.dev/docs/api/request#url}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const url = c.req.url // `http://localhost:8787/about/me`
  *   ...
  * })
  * ```
  */
  get url() {
    return this.raw.url;
  }
  /**
  * `.method` can get the method name of the request.
  *
  * @see {@link https://hono.dev/docs/api/request#method}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const method = c.req.method // `GET`
  * })
  * ```
  */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
  * `.matchedRoutes` can return a matched route in the handler
  *
  * @deprecated
  *
  * Use matchedRoutes helper defined in "hono/route" instead.
  *
  * @see {@link https://hono.dev/docs/api/request#matchedroutes}
  *
  * @example
  * ```ts
  * app.use('*', async function logger(c, next) {
  *   await next()
  *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
  *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
  *     console.log(
  *       method,
  *       ' ',
  *       path,
  *       ' '.repeat(Math.max(10 - path.length, 0)),
  *       name,
  *       i === c.req.routeIndex ? '<- respond from here' : ''
  *     )
  *   })
  * })
  * ```
  */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
  * `.routePath` can retrieve the path registered within the handler
  *
  * @deprecated
  *
  * Use routePath helper defined in "hono/route" instead.
  *
  * @see {@link https://hono.dev/docs/api/request#routepath}
  *
  * @example
  * ```ts
  * app.get('/posts/:id', (c) => {
  *   return c.json({ path: c.req.routePath })
  * })
  * ```
  */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = (value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) str = str.toString();
    if (str instanceof Promise) str = await str;
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) return Promise.resolve(str);
  if (buffer) buffer[0] += str;
  else buffer = [str];
  const resStr = Promise.all(callbacks.map((c) => c({
    phase,
    buffer,
    context
  }))).then((res) => Promise.all(res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))).then(() => buffer[0]));
  if (preserveCallbacks) return raw(await resStr, callbacks);
  else return resStr;
};

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
};
var createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
  #rawRequest;
  #req;
  /**
  * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
  *
  * @see {@link https://hono.dev/docs/api/context#env}
  *
  * @example
  * ```ts
  * // Environment object for Cloudflare Workers
  * app.get('*', async c => {
  *   const counter = c.env.COUNTER
  * })
  * ```
  */
  env = {};
  #var;
  finalized = false;
  /**
  * `.error` can get the error object from the middleware if the Handler throws an error.
  *
  * @see {@link https://hono.dev/docs/api/context#error}
  *
  * @example
  * ```ts
  * app.use('*', async (c, next) => {
  *   await next()
  *   if (c.error) {
  *     // do something...
  *   }
  * })
  * ```
  */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
  * Creates an instance of the Context class.
  *
  * @param req - The Request object.
  * @param options - Optional configuration options for the context.
  */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
  * `.req` is the instance of {@link HonoRequest}.
  */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#event}
  * The FetchEvent associated with the current request.
  *
  * @throws Will throw an error if the context does not have a FetchEvent.
  */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) return this.#executionCtx;
    else throw Error("This context has no FetchEvent");
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#executionctx}
  * The ExecutionContext associated with the current request.
  *
  * @throws Will throw an error if the context does not have an ExecutionContext.
  */
  get executionCtx() {
    if (this.#executionCtx) return this.#executionCtx;
    else throw Error("This context has no ExecutionContext");
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#res}
  * The Response object for the current request.
  */
  get res() {
    return this.#res ||= createResponseInstance(null, { headers: this.#preparedHeaders ??= new Headers() });
  }
  /**
  * Sets the Response object for the current request.
  *
  * @param _res - The Response object to set.
  */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") continue;
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) _res.headers.append("set-cookie", cookie);
        } else _res.headers.set(k, v);
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
  * `.render()` can create a response within a layout.
  *
  * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
  *
  * @example
  * ```ts
  * app.get('/', (c) => {
  *   return c.render('Hello!')
  * })
  * ```
  */
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  /**
  * Sets the layout for the response.
  *
  * @param layout - The layout to set.
  * @returns The layout function.
  */
  setLayout = (layout) => this.#layout = layout;
  /**
  * Gets the current layout for the response.
  *
  * @returns The current layout function.
  */
  getLayout = () => this.#layout;
  /**
  * `.setRenderer()` can set the layout in the custom middleware.
  *
  * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
  *
  * @example
  * ```tsx
  * app.use('*', async (c, next) => {
  *   c.setRenderer((content) => {
  *     return c.html(
  *       <html>
  *         <body>
  *           <p>{content}</p>
  *         </body>
  *       </html>
  *     )
  *   })
  *   await next()
  * })
  * ```
  */
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  /**
  * `.header()` can set headers.
  *
  * @see {@link https://hono.dev/docs/api/context#header}
  *
  * @example
  * ```ts
  * app.get('/welcome', (c) => {
  *   // Set headers
  *   c.header('X-Message', 'Hello!')
  *   c.header('Content-Type', 'text/plain')
  *
  *   // Append multiple headers using the append option (e.g. Vary)
  *   c.header('Vary', 'Accept-Encoding', { append: true })
  *   c.header('Vary', 'User-Agent', { append: true })
  *
  *   return c.body('Thank you for coming')
  * })
  * ```
  */
  header = (name, value, options) => {
    if (this.finalized) this.#res = createResponseInstance(this.#res.body, this.#res);
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) headers.delete(name);
    else if (options?.append) headers.append(name, value);
    else headers.set(name, value);
  };
  status = (status) => {
    this.#status = status;
  };
  /**
  * `.set()` can set the value specified by the key.
  *
  * @see {@link https://hono.dev/docs/api/context#set-get}
  *
  * @example
  * ```ts
  * app.use('*', async (c, next) => {
  *   c.set('message', 'Hono is hot!!')
  *   await next()
  * })
  * ```
  */
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  };
  /**
  * `.get()` can use the value specified by the key.
  *
  * @see {@link https://hono.dev/docs/api/context#set-get}
  *
  * @example
  * ```ts
  * app.get('/', (c) => {
  *   const message = c.get('message')
  *   return c.text(`The message is "${message}"`)
  * })
  * ```
  */
  get = (key) => {
    return this.#var ? this.#var.get(key) : void 0;
  };
  /**
  * `.var` can access the value of a variable.
  *
  * @see {@link https://hono.dev/docs/api/context#var}
  *
  * @example
  * ```ts
  * const result = c.var.client.oneMethod()
  * ```
  */
  get var() {
    if (!this.#var) return {};
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
    if (typeof arg === "object" && arg.headers) {
      responseHeaders ??= new Headers();
      for (const [key, value] of new Headers(arg.headers)) if (key === "set-cookie") responseHeaders.append(key, value);
      else responseHeaders.set(key, value);
    }
    if (headers) {
      if (!responseHeaders) {
        let count = 0;
        for (const k in headers) if (++count > 1 || typeof headers[k] !== "string") {
          responseHeaders = new Headers();
          break;
        }
      }
      if (responseHeaders) for (const k in headers) {
        const v = headers[k];
        if (typeof v === "string") responseHeaders.set(k, v);
        else {
          responseHeaders.delete(k);
          for (const v2 of v) responseHeaders.append(k, v2);
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, {
      status,
      headers: responseHeaders ?? headers
    });
  }
  newResponse = (...args) => this.#newResponse(...args);
  /**
  * `.body()` can return the HTTP response.
  * You can set headers with `.header()` and set HTTP status code with `.status`.
  * This can also be set in `.text()`, `.json()` and so on.
  *
  * @see {@link https://hono.dev/docs/api/context#body}
  *
  * @example
  * ```ts
  * app.get('/welcome', (c) => {
  *   // Set headers
  *   c.header('X-Message', 'Hello!')
  *   c.header('Content-Type', 'text/plain')
  *   // Set HTTP status code
  *   c.status(201)
  *
  *   // Return the response body
  *   return c.body('Thank you for coming')
  * })
  * ```
  */
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  /**
  * `.text()` can render text as `Content-Type:text/plain`.
  *
  * @see {@link https://hono.dev/docs/api/context#text}
  *
  * @example
  * ```ts
  * app.get('/say', (c) => {
  *   return c.text('Hello!')
  * })
  * ```
  */
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
  };
  /**
  * `.json()` can render JSON as `Content-Type:application/json`.
  *
  * @see {@link https://hono.dev/docs/api/context#json}
  *
  * @example
  * ```ts
  * app.get('/api', (c) => {
  *   return c.json({ message: 'Hello!' })
  * })
  * ```
  */
  json = (object, arg, headers) => {
    return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
  };
  html = (html, arg, headers) => {
    const res = (html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  /**
  * `.redirect()` can Redirect, default status code is 302.
  *
  * @see {@link https://hono.dev/docs/api/context#redirect}
  *
  * @example
  * ```ts
  * app.get('/redirect', (c) => {
  *   return c.redirect('/')
  * })
  * app.get('/redirect-permanently', (c) => {
  *   return c.redirect('/', 301)
  * })
  * ```
  */
  redirect = (location, status) => {
    const locationString = String(location);
    this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
    return this.newResponse(null, status ?? 302);
  };
  /**
  * `.notFound()` can return the Not Found Response.
  *
  * @see {@link https://hono.dev/docs/api/context#notfound}
  *
  * @example
  * ```ts
  * app.get('/notfound', (c) => {
  *   return c.notFound()
  * })
  * ```
  */
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
};

// node_modules/hono/dist/compose.js
var compose = (middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else handler = i === middleware.length && next || void 0;
      if (handler) try {
        res = await handler(context, () => dispatch(i + 1));
      } catch (err) {
        if (err instanceof Error && onError) {
          context.error = err;
          res = await onError(err, context);
          isError = true;
        } else throw err;
      }
      else if (context.finalized === false && onNotFound) res = await onNotFound(context);
      if (res && (context.finalized === false || isError)) context.res = res;
      return context;
    }
  };
};

// node_modules/hono/dist/router.js
var METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "options",
  "patch",
  "query"
];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
};

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
var Hono = class Hono2 {
  get;
  post;
  put;
  delete;
  options;
  patch;
  query;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    [...METHODS, "all"].forEach((method) => {
      this[method] = (args1, ...args) => {
        const methodName = method.toUpperCase();
        if (typeof args1 === "string") this.#path = args1;
        else this.#addRoute(methodName, this.#path, args1);
        args.forEach((handler) => {
          this.#addRoute(methodName, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          const methodName = m.toUpperCase();
          for (const handler of handlers) this.#addRoute(methodName, this.#path, handler);
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") this.#path = arg1;
      else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute("ALL", this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new Hono2({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  errorHandler = errorHandler;
  /**
  * `.route()` allows grouping other Hono instance in routes.
  *
  * @see {@link https://hono.dev/docs/api/routing#grouping}
  *
  * @param {string} path - base Path
  * @param {Hono} app - other Hono instance
  * @returns {Hono} routed Hono instance
  *
  * @example
  * ```ts
  * const app = new Hono()
  * const app2 = new Hono()
  *
  * app2.get("/user", (c) => c.text("user"))
  * app.route("/api", app2) // GET /api/user
  * ```
  */
  route(path, app2) {
    const subApp = this.basePath(path);
    app2.routes.map((r) => {
      let handler;
      if (app2.errorHandler === errorHandler) handler = r.handler;
      else {
        handler = async (c, next) => (await compose([], app2.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
  * `.basePath()` allows base paths to be specified.
  *
  * @see {@link https://hono.dev/docs/api/routing#base-path}
  *
  * @param {string} path - base Path
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * const api = new Hono().basePath('/api')
  * ```
  */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
  * `.onError()` handles an error and returns a customized Response.
  *
  * @see {@link https://hono.dev/docs/api/hono#error-handling}
  *
  * @param {ErrorHandler} handler - request Handler for error
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * app.onError((err, c) => {
  *   console.error(`${err}`)
  *   return c.text('Custom Error Message', 500)
  * })
  * ```
  */
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  /**
  * `.notFound()` allows you to customize a Not Found Response.
  *
  * @see {@link https://hono.dev/docs/api/hono#not-found}
  *
  * @param {NotFoundHandler} handler - request handler for not-found
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * app.notFound((c) => {
  *   return c.text('Custom 404 Message', 404)
  * })
  * ```
  */
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  /**
  * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
  *
  * @deprecated Use `mount()` from `hono/mount` instead. `.mount()` will be removed in v5.
  *
  * @see {@link https://hono.dev/docs/api/hono#mount}
  *
  * @param {string} path - base Path
  * @param {Function} applicationHandler - other Request Handler
  * @param {MountOptions} [options] - options of `.mount()`
  * @returns {Hono} mounted Hono instance
  *
  * @example
  * ```ts
  * import { Router as IttyRouter } from 'itty-router'
  * import { Hono } from 'hono'
  * // Create itty-router application
  * const ittyRouter = IttyRouter()
  * // GET /itty-router/hello
  * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
  *
  * const app = new Hono()
  * app.mount('/itty-router', ittyRouter.handle)
  * ```
  *
  * @example
  * ```ts
  * const app = new Hono()
  * // Send the request to another application without modification.
  * app.mount('/app', anotherApp, {
  *   replaceRequest: (req) => req,
  * })
  * ```
  */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") optionHandler = options;
      else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) replaceRequest = (request) => request;
        else replaceRequest = options.replaceRequest;
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) return res;
      await next();
    };
    this.#addRoute("ALL", mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) return this.errorHandler(err, c);
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
  * `.fetch()` will be entry point of your app.
  *
  * @see {@link https://hono.dev/docs/api/hono#fetch}
  *
  * @param {Request} request - request Object of request
  * @param {Env} env - env Object
  * @param {ExecutionContext} executionCtx - context of execution
  * @returns {Response | Promise<Response>} response of request
  *
  */
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  /**
  * `.request()` is a useful method for testing.
  * You can pass a URL or pathname to send a GET request.
  * app will return a Response object.
  * ```ts
  * test('GET /hello is ok', async () => {
  *   const res = await app.request('/hello')
  *   expect(res.status).toBe(200)
  * })
  * ```
  * @see https://hono.dev/docs/api/hono#request
  */
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    input = input.toString();
    return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
  };
  /**
  * `.fire()` automatically adds a global fetch event listener.
  * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
  * @deprecated
  * Use `fire` from `hono/service-worker` instead.
  * ```ts
  * import { Hono } from 'hono'
  * import { fire } from 'hono/service-worker'
  *
  * const app = new Hono()
  * // ...
  * fire(app)
  * ```
  * @see https://hono.dev/docs/api/hono#fire
  * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
  * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
  */
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  };
};

// node_modules/hono/dist/router/utils.js
var createNullObject = () => /* @__PURE__ */ Object.create(null);

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = ((method2, path2) => {
    const matcher = matchers[method2] || matchers["ALL"];
    const staticMatch = matcher[2][path2];
    if (staticMatch) return staticMatch;
    const match3 = path2.match(matcher[0]);
    if (!match3) return [[], emptyParam];
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  });
  this.match = match2;
  return match2(method, path);
}

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = /* @__PURE__ */ new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) return b.length === 1 ? a < b ? -1 : 1 : -1;
  if (b.length === 1) return 1;
  if (a === ".*" || a === "(?:|/.*)") return b === "(?:|/.*)" ? -1 : 1;
  else if (b === ".*" || b === "(?:|/.*)") return -1;
  if (a === "[^/]+") return 1;
  else if (b === "[^/]+") return -1;
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node = class Node2 {
  #index;
  #varIndex;
  #children = createNullObject();
  insert(tokens, index, paramMap, context, isStatic) {
    let node = this;
    for (let i = 0, len = tokens.length; i < len; i++) {
      const token = tokens[i];
      const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? [
        "",
        "",
        ".*"
      ] : [
        "",
        "",
        LABEL_REG_EXP_STR
      ] : null : token === "/*" ? [
        "",
        "",
        TAIL_WILDCARD_REG_EXP_STR
      ] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
      let nextNode;
      if (pattern) {
        const name = pattern[1];
        let regexpStr = pattern[2] || "[^/]+";
        if (name && pattern[2]) {
          if (regexpStr === ".*") throw PATH_ERROR;
          regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
          if (/\((?!\?:)/.test(regexpStr)) throw PATH_ERROR;
          if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) throw PATH_ERROR;
        }
        nextNode = node.#children[regexpStr];
        if (!nextNode) {
          if (regexpStr !== ".*" && regexpStr !== "(?:|/.*)") {
            for (const k in node.#children) if ((regexpStr.length > 1 || k.length > 1) && k !== ".*" && k !== "(?:|/.*)") throw PATH_ERROR;
          }
          nextNode = node.#children[regexpStr] = new Node2();
        }
        if (name !== "") {
          nextNode.#varIndex ??= context.varIndex++;
          paramMap.push([name, nextNode.#varIndex]);
        }
      } else {
        nextNode = node.#children[token];
        if (!nextNode) {
          for (const k in node.#children) if (k.length > 1 && k !== ".*" && k !== "(?:|/.*)") throw PATH_ERROR;
          nextNode = node.#children[token] = new Node2();
        }
      }
      node = nextNode;
    }
    if (node.#index !== void 0) throw PATH_ERROR;
    node.#index = isStatic ? -1 : index;
  }
  buildRegExpStr() {
    const strList = Object.keys(this.#children).sort(compareKey).map((k) => {
      const c = this.#children[k];
      const childStr = c.buildRegExpStr();
      return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
    }).filter(Boolean);
    if (typeof this.#index === "number" && this.#index !== -1) strList.unshift(`#${this.#index}`);
    if (strList.length === 0) return "";
    if (strList.length === 1) return strList[0];
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  #context = { varIndex: 0 };
  #root = new Node();
  #index = 0;
  paths = createNullObject();
  insert(path, isStatic) {
    if (isStatic) {
      this.#root.insert(path.split(""), 0, [], this.#context, true);
      return;
    }
    const paramAssoc = [];
    const groups = [];
    let markedPath = path;
    for (let i = 0; ; ) {
      let replaced = false;
      markedPath = markedPath.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) break;
    }
    const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) if (tokens[j].indexOf(mark) !== -1) {
        tokens[j] = tokens[j].replace(mark, groups[i][1]);
        break;
      }
    }
    this.#root.insert(tokens, this.#index, paramAssoc, this.#context, false);
    this.paths[path] = [this.#index++, paramAssoc];
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") return [
      /^$/,
      [],
      []
    ];
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [
      new RegExp(`^${regexp}`),
      indexReplacementMap,
      paramReplacementMap
    ];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
var wildcardRegExpCache = createNullObject();
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(`^${path.replace(/\/:[^/{}]+(?:\{\[\^\/]\+})?(?=[/{]|$)|\/?\*$|([.\\+*[^\]$()?{}|])/g, (match2, metaChar) => metaChar ? `\\${metaChar}` : match2 === "/*" ? TAIL_WILDCARD_REG_EXP_STR : match2 === "*" ? ".*" : `/:${LABEL_REG_EXP_STR}`)}$`);
}
function findMiddleware(middleware, path) {
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) if (buildWildcardRegExp(k).test(path)) return [...middleware[k]];
}
var RegExpRouter = class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  #tries;
  constructor() {
    this.#middleware = { ["ALL"]: createNullObject() };
    this.#routes = { ["ALL"]: createNullObject() };
    this.#tries = { ["ALL"]: new Trie() };
  }
  #insertPath(method, path) {
    try {
      this.#tries[method].insert(path, !/\*|\/:/.test(path));
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    if (!middleware[method]) {
      this.#tries[method] = new Trie();
      for (const handlerMap of [middleware, routes]) {
        handlerMap[method] = createNullObject();
        for (const p in handlerMap["ALL"]) {
          handlerMap[method][p] = [...handlerMap["ALL"][p]];
          this.#insertPath(method, p);
        }
      }
    }
    if (path === "/*") path = "*";
    const methods = method === "ALL" ? Object.keys(middleware) : [method];
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      for (const m of methods) if (!middleware[m][path]) {
        this.#insertPath(m, path);
        middleware[m][path] = findMiddleware(middleware[m], path) || findMiddleware(middleware["ALL"], path) || [];
      }
      for (const handlerMap of [middleware, routes]) for (const m of methods) for (const p in handlerMap[m]) re.test(p) && handlerMap[m][p].push([handler, path]);
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (const path2 of paths) for (const m of methods) {
      if (!routes[m][path2]) {
        this.#insertPath(m, path2);
        routes[m][path2] = findMiddleware(middleware[m], path2) || findMiddleware(middleware["ALL"], path2) || [];
      }
      routes[m][path2].push([handler, path2]);
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = createNullObject();
    for (const method of Object.keys(this.#routes)) matchers[method] = this.#buildMatcher(method);
    this.#middleware = this.#routes = this.#tries = void 0;
    wildcardRegExpCache = createNullObject();
    return matchers;
  }
  #buildMatcher(method) {
    const middleware = this.#middleware[method];
    const routes = this.#routes[method];
    const trie = this.#tries[method];
    const staticMap = createNullObject();
    const handlerData = [];
    const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
    for (const r of [middleware, routes]) for (const path in r) {
      const handlers = r[path];
      const pathData = trie.paths[path];
      if (!pathData) {
        staticMap[path] = [handlers.map(([h]) => [h, createNullObject()]), emptyParam];
        continue;
      }
      handlerData[pathData[0]] = handlers.map(([h, handlerPath]) => [h, trie.paths[handlerPath][1].reduceRight((map, [key], i) => {
        map[key] = paramReplacementMap[pathData[1][i][1]];
        return map;
      }, createNullObject())]);
    }
    return [
      regexp,
      indexReplacementMap.map((i) => handlerData[i]),
      staticMap
    ];
  }
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    this.#routes.push([
      method,
      path,
      handler
    ]);
  }
  match(method, path) {
    if (!this.#routes) throw new Error("Fatal error");
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) router.add(...routes[i2]);
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) continue;
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) throw new Error("Fatal error");
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) throw new Error("No active router has been determined yet.");
    return this.#routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = createNullObject();
var order = 0;
var Node3 = class Node4 {
  #methods = [];
  #children = createNullObject();
  #patterns = [];
  #pattern;
  #params = emptyParams;
  insert(method, path, handler) {
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = /* @__PURE__ */ new Set();
    let i = 0;
    for (const p of parts) {
      const nextP = parts[++i];
      const pattern = getPattern(p, nextP) || (nextP === void 0 && p && p.indexOf("*") === p.length - 1 ? p : null);
      const isParam = Array.isArray(pattern);
      const key = isParam ? pattern[0] : pattern || p;
      const child = curNode.#children[key] ||= new Node4();
      if (pattern && !child.#pattern) {
        child.#pattern = pattern;
        curNode.#patterns.push(child);
      }
      curNode = child;
      if (isParam) possibleKeys.add(pattern[1]);
    }
    curNode.#methods.push({ [method]: {
      handler,
      possibleKeys: [...possibleKeys],
      score: ++order
    } });
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m["ALL"];
      if (handlerSet) {
        handlerSet.params = createNullObject();
        handlerSets.push(handlerSet);
        for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
          const key = handlerSet.possibleKeys[i2];
          handlerSet.params[key] = params?.[key] && !i2 ? params[key] : nodeParams[key] ?? params?.[key];
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    let curNodes = [this];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else tempNodes.push(nextNode);
        }
        for (const child of node.#patterns) {
          const pattern = child.#pattern;
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (typeof pattern === "string") {
            if (pattern === "*" || part.startsWith(pattern.slice(0, -1))) {
              this.#pushHandlerSets(handlerSets, child, method, node.#params);
              if (pattern === "*") {
                child.#params = params;
                tempNodes.push(child);
              }
            }
            continue;
          }
          const [, name, matcher] = pattern;
          if (!part && matcher === true) continue;
          if (matcher !== true) {
            if (!partOffsets) {
              partOffsets = [];
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.slice(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (m[0].length === restPathString.length && child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, node.#params, params);
              for (const _ in child.#children) {
                child.#params = params;
                const componentCount = m[0].match(/\//g)?.length ?? 0;
                (curNodesQueue[componentCount] ||= []).push(child);
                break;
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets[1]) handlerSets.sort((a, b) => {
      return a.score - b.score;
    });
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  name = "TrieRouter";
  #node = new Node3();
  add(method, path, handler) {
    for (const result of checkOptionalParameter(path) || [path]) this.#node.insert(method, result, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono3 = class extends Hono {
  /**
  * Creates an instance of the Hono class.
  *
  * @param options - Optional configuration options for the Hono instance.
  */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
  }
};

// worker/index.js
var app = new Hono3();
var VERSION = "3.0.0";
var REPOS = [
  { name: "faceless-studio", event: "opshub.produce" },
  { name: "faceless-turkce-studio", event: "opshub.produce" },
  { name: "deep-history-studio", event: "opshub.produce" },
  { name: "business-flip-", event: "opshub.produce" },
  { name: "icc-engine", event: "icc.run" }
];
var REPO_NAMES = REPOS.map((r) => r.name);
var REPORT_TTL_S = 900;
var WEATHER_TTL_S = 21600;
var FF_TTL_S = 21600;
var HEADLINES_TTL_S = 1800;
var DEFAULT_SETTINGS = {
  tz: "Europe/Nicosia",
  place: "Cyprus",
  lat: 35.17,
  lon: 33.36
};
var CURRENCIES = {
  "United States": "USD",
  "Euro Zone": "EUR",
  "European Union": "EUR",
  Germany: "EUR",
  France: "EUR",
  Italy: "EUR",
  Spain: "EUR",
  Netherlands: "EUR",
  Belgium: "EUR",
  Austria: "EUR",
  Portugal: "EUR",
  Ireland: "EUR",
  Greece: "EUR",
  Finland: "EUR",
  "United Kingdom": "GBP",
  Japan: "JPY",
  Canada: "CAD",
  Australia: "AUD",
  "New Zealand": "NZD",
  Switzerland: "CHF",
  China: "CNY",
  Turkey: "TRY",
  "T\xFCrkiye": "TRY",
  Russia: "RUB",
  Brazil: "BRL",
  Mexico: "MXN",
  India: "INR",
  "South Korea": "KRW",
  "South Africa": "ZAR",
  Sweden: "SEK",
  Norway: "NOK",
  Denmark: "DKK",
  Poland: "PLN",
  "Saudi Arabia": "SAR",
  "United Arab Emirates": "AED",
  Qatar: "QAR",
  Israel: "ILS",
  Singapore: "SGD",
  "Hong Kong": "HKD",
  Indonesia: "IDR",
  Thailand: "THB",
  Malaysia: "MYR",
  Philippines: "PHP",
  Egypt: "EGP",
  Nigeria: "NGN",
  Ukraine: "UAH",
  "Czech Republic": "CZK",
  Hungary: "HUF",
  Romania: "RON",
  Iceland: "ISK",
  Pakistan: "PKR",
  Taiwan: "TWD",
  Colombia: "COP",
  Chile: "CLP",
  Peru: "PEN",
  Argentina: "ARS",
  Kenya: "KES"
};
var FEEDS = [
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "ForexLive", url: "https://www.forexlive.com/feed/news" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "CNN", url: "https://rss.cnn.com/rss/edition.rss" },
  { name: "DW", url: "https://rss.dw.com/rdf/rss-en" }
];
app.get("/", async (ctx) => {
  return ctx.json({ status: "ok", version: VERSION, mode: "Telegram-first" });
});
async function sendTelegram(botToken, chatId, text) {
  try {
    await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "OpsHub" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4e3) })
    });
    return true;
  } catch (e) {
    console.error("Failed to send Telegram reply:", e);
    return false;
  }
}
async function ghGet(path, token) {
  const r = await fetch("https://api.github.com" + path, {
    headers: {
      Authorization: "token " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "OpsHub"
    }
  });
  if (!r.ok) throw new Error("github " + r.status + " " + path);
  return r.json();
}
async function dispatchGitHub(token, repo, eventType, payload) {
  const resp = await fetch(
    "https://api.github.com/repos/landryparadis012-git/" + repo + "/dispatches",
    {
      method: "POST",
      headers: {
        Authorization: "token " + token,
        Accept: "application/vnd.github+json",
        "User-Agent": "OpsHub"
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload || {} })
    }
  );
  return resp.ok;
}
async function callGroq(groqKey, messages) {
  const groqResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + groqKey,
      "User-Agent": "OpsHub"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages,
      max_tokens: 500
    })
  });
  const data = await groqResp.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  console.error("Groq error:", JSON.stringify(data).slice(0, 400));
  return null;
}
async function kvGet(db, k) {
  const row = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return row ? row.v : null;
}
async function kvSet(db, k, v) {
  await db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, typeof v === "string" ? v : JSON.stringify(v)).run();
}
async function ensureTables(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS dispatched (id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT UNIQUE, repo TEXT, series TEXT, episode TEXT, dispatched_at TEXT)"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, type TEXT, payload TEXT, received_at INTEGER)"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER NOT NULL, repeat_h INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT)"
  ).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)").run();
}
async function getSettings(db) {
  try {
    const raw2 = await kvGet(db, "settings");
    if (raw2) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw2) };
  } catch (e) {
  }
  return { ...DEFAULT_SETTINGS };
}
async function saveSettings(db, patch) {
  const cur = await getSettings(db);
  const next = { ...cur, ...patch };
  await kvSet(db, "settings", next);
  return next;
}
function tzValid(tz) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function localEpochParts(d, tz) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return {
    y: parseInt(p.year, 10),
    mo: parseInt(p.month, 10),
    d: parseInt(p.day, 10),
    h: parseInt(p.hour, 10) % 24,
    mi: parseInt(p.minute, 10)
  };
}
function localParts(d, tz) {
  const p = localEpochParts(d, tz);
  return {
    date: `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`,
    hour: p.h,
    hhmm: `${pad2(p.h)}:${pad2(p.mi)}`,
    weekday: new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d)
  };
}
function zonedTimeToEpoch(str, tz) {
  const m = String(str).match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localEpochParts(new Date(guess), tz);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0);
    const diff = want - got;
    if (diff === 0) break;
    guess += diff;
  }
  return Math.floor(guess / 1e3);
}
function zonedDayStart(nowMs, tz) {
  const p = localEpochParts(new Date(nowMs), tz);
  return zonedTimeToEpoch(`${p.y}-${pad2(p.mo)}-${pad2(p.d)} 00:00`, tz);
}
function fmtClock(epoch, tz) {
  const p = localEpochParts(new Date(epoch * 1e3), tz);
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}
function fmtDayClock(epoch, tz) {
  const p = localEpochParts(new Date(epoch * 1e3), tz);
  return `${pad2(p.d)}.${pad2(p.mo)} ${pad2(p.h)}:${pad2(p.mi)}`;
}
async function verifySignature(rawBody, header, secret) {
  if (!secret) return true;
  if (!header) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = "sha256=" + hex;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
async function storeEvent(db, body) {
  const eventId = body.event_id || (body.type ? body.type + ":" + Math.random().toString(36).slice(2, 12) : null);
  if (!eventId || !body.type) return { stored: false, reason: "no event_id/type" };
  const res = await db.prepare(
    "INSERT OR IGNORE INTO events (event_id, type, payload, received_at) VALUES (?, ?, ?, ?)"
  ).bind(eventId, body.type, JSON.stringify(body), Math.floor(Date.now() / 1e3)).run();
  const changed = res.meta && (res.meta.changes ?? 0);
  return { stored: changed > 0 };
}
function normChat(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.trunc(n)) : String(v);
}
async function addReminder(db, chatId, text, hours, repeatH, dueOverride) {
  const due = dueOverride != null ? Math.floor(dueOverride) : Math.floor(Date.now() / 1e3) + Math.floor(hours * 3600);
  const repeat = repeatH > 0 ? Math.floor(repeatH) : 0;
  const res = await db.prepare(
    "INSERT INTO reminders (chat_id, text, due_at, repeat_h, active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
  ).bind(normChat(chatId), text, due, repeat, (/* @__PURE__ */ new Date()).toISOString()).run();
  return { id: res.meta && res.meta.last_row_id, due };
}
async function listReminders(db, chatId) {
  const rs = await db.prepare(
    "SELECT id, text, due_at, repeat_h FROM reminders WHERE active = 1 AND CAST(chat_id AS REAL) = CAST(? AS REAL) ORDER BY due_at ASC LIMIT 30"
  ).bind(chatId).all();
  return rs.results || [];
}
async function deleteReminder(db, chatId, id) {
  const row = await db.prepare(
    "SELECT id, text FROM reminders WHERE id = ? AND CAST(chat_id AS REAL) = CAST(? AS REAL) AND active = 1"
  ).bind(id, chatId).first();
  if (!row) return null;
  await db.prepare(
    "UPDATE reminders SET active = 0 WHERE id = ? AND CAST(chat_id AS REAL) = CAST(? AS REAL)"
  ).bind(id, chatId).run();
  return row;
}
function repeatLabel(repeatH) {
  if (!repeatH) return "";
  if (repeatH % 168 === 0 && repeatH >= 168) return ` every ${repeatH / 168}w`;
  if (repeatH % 24 === 0) return ` daily${repeatH > 24 ? ` every ${repeatH / 24}d` : ""}`;
  return ` every ${repeatH}h`;
}
function fmtDue(dueAt, settings) {
  const delta = dueAt - Math.floor(Date.now() / 1e3);
  const clock = `${fmtClock(dueAt, settings.tz)} ${settings.place} time`;
  if (delta <= 0) return `due now \xB7 was ${clock}`;
  const h = Math.floor(delta / 3600);
  const m = Math.floor(delta % 3600 / 60);
  if (h >= 48) return `in ${Math.floor(h / 24)}d \xB7 ${fmtDayClock(dueAt, settings.tz)}`;
  if (h > 0) return `in ${h}h ${m}m \xB7 ${clock}`;
  return `in ${m}m \xB7 ${clock}`;
}
function remindersText(rows, settings) {
  if (!rows.length) {
    return 'Active reminders:\n(none)\n\nSet one with:\n/remind 48 <text> \u2014 one-shot in 48h\n/remind 24 every <text> \u2014 repeats every 24h\nor just say e.g. "remind me every day at 08:00 to check the studios"';
  }
  const lines = rows.map(
    (r) => `#${r.id} ${fmtDue(r.due_at, settings)}${repeatLabel(r.repeat_h)} \u2014 ${r.text}`
  );
  return "Active reminders:\n" + lines.join("\n") + "\n\nCancel: /delete <id>";
}
async function getChatLog(db, chatId) {
  try {
    const raw2 = await kvGet(db, "chatlog:" + normChat(chatId));
    const arr = raw2 ? JSON.parse(raw2) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}
async function pushChatLog(db, chatId, role, text) {
  try {
    const log = await getChatLog(db, chatId);
    log.push({ r: role, t: String(text).slice(0, 300) });
    while (log.length > 8) log.shift();
    await kvSet(db, "chatlog:" + normChat(chatId), log);
  } catch (e) {
  }
}
function wmo(code) {
  if (code === 0) return { i: "\u2600\uFE0F", t: "clear" };
  if (code <= 2) return { i: "\u{1F324}", t: "partly cloudy" };
  if (code === 3) return { i: "\u2601\uFE0F", t: "overcast" };
  if (code === 45 || code === 48) return { i: "\u{1F32B}", t: "fog" };
  if (code >= 51 && code <= 67) return { i: "\u{1F327}", t: "rain/showers" };
  if (code >= 71 && code <= 77) return { i: "\u{1F328}", t: "snow" };
  if (code >= 80 && code <= 82) return { i: "\u{1F326}", t: "showers" };
  if (code >= 85 && code <= 86) return { i: "\u{1F328}", t: "snow showers" };
  if (code >= 95) return { i: "\u26C8", t: "thunderstorm" };
  return { i: "\u2022", t: "" };
}
function feelFor(maxC) {
  if (maxC >= 32) return "hot \u2014 plan outdoor stuff early or late";
  if (maxC >= 24) return "warm \u2014 good for outdoor plans";
  if (maxC >= 16) return "mild \u2014 fine to be outside";
  if (maxC >= 8) return "cold \u2014 dress warm, indoor-friendly day";
  return "freezing \u2014 keep plans indoors";
}
async function getWeather(ctx, settings) {
  const db = ctx.env.DB;
  try {
    const raw2 = await kvGet(db, "weather");
    if (raw2) {
      const w = JSON.parse(raw2);
      if (Date.now() / 1e3 - w.t < WEATHER_TTL_S && w.lat === settings.lat && w.tz === settings.tz) {
        return w;
      }
    }
  } catch (e) {
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${settings.lat}&longitude=${settings.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=${encodeURIComponent(settings.tz)}&forecast_days=3`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8e3) });
    const j = await r.json();
    const w = {
      t: Date.now() / 1e3,
      lat: settings.lat,
      tz: settings.tz,
      cur: j.current || null,
      today: {
        max: j.daily.temperature_2m_max[0],
        min: j.daily.temperature_2m_min[0],
        rain: j.daily.precipitation_probability_max?.[0] ?? 0,
        code: j.daily.weather_code[0]
      },
      tom: {
        max: j.daily.temperature_2m_max[1],
        min: j.daily.temperature_2m_min[1],
        rain: j.daily.precipitation_probability_max?.[1] ?? 0,
        code: j.daily.weather_code[1]
      }
    };
    try {
      await kvSet(db, "weather", w);
    } catch (e) {
    }
    return w;
  } catch (e) {
    return null;
  }
}
function weatherLine(w, settings) {
  if (!w || !w.today) return null;
  const now = w.cur ? `${Math.round(w.cur.temperature_2m)}\xB0C ${wmo(w.cur.weather_code).t}` : null;
  return `\u{1F321} ${now ? now + " \xB7 " : ""}today ${Math.round(w.today.max)}\xB0/${Math.round(w.today.min)}\xB0 ${wmo(w.today.code).i} ${feelFor(w.today.max)} \xB7 rain ${w.today.rain}% (tomorrow ${Math.round(w.tom.max)}\xB0/${Math.round(w.tom.min)}\xB0, rain ${w.tom.rain}%)`;
}
async function weatherTextCmd(ctx, settings) {
  const w = await getWeather(ctx, settings);
  if (!w) return `Weather unavailable right now (checked ${settings.lat}, ${settings.lon} \u2014 ${settings.place}).`;
  const now = w.cur ? `Now: ${Math.round(w.cur.temperature_2m)}\xB0C, ${wmo(w.cur.weather_code).t}, wind ${Math.round(w.cur.wind_speed_10m)} km/h` : "";
  const day = (lbl, d) => `${lbl}: ${Math.round(d.max)}\xB0/${Math.round(d.min)}\xB0 ${wmo(d.code).i} ${wmo(d.code).t}, rain ${d.rain}% \u2014 ${feelFor(d.max)}`;
  return `Weather for ${settings.place}:
${now}
${day("Today", w.today)}
${day("Tomorrow", w.tom)}`;
}
function parseFF(xml) {
  const events = [];
  const blocks = xml.split("<event>").slice(1);
  for (const braw of blocks) {
    const b = braw.split("</event>")[0];
    const tag = (n) => {
      const m = b.match(new RegExp(`<${n}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${n}>`));
      return m ? m[1].trim() : "";
    };
    const title = tag("title");
    const country = tag("country");
    const date = tag("date");
    const impact = tag("impact");
    if (!title || !date) continue;
    const ts = Date.parse(date);
    if (!Number.isFinite(ts)) continue;
    events.push({
      title,
      country,
      impact,
      ts: Math.floor(ts / 1e3),
      forecast: tag("forecast"),
      previous: tag("previous"),
      actual: tag("actual")
    });
  }
  return events.sort((a, b) => a.ts - b.ts);
}
async function getFF(ctx, force) {
  const db = ctx.env.DB;
  if (!force) {
    try {
      const raw2 = await kvGet(db, "ffcal");
      if (raw2) {
        const c = JSON.parse(raw2);
        if (Date.now() / 1e3 - c.t < FF_TTL_S && c.events?.length) return c.events;
      }
    } catch (e) {
    }
  }
  try {
    const r = await fetch(
      "https://nfs.faireconomy.media/ff_calendar_thisweek.xml",
      { signal: AbortSignal.timeout(1e4), headers: { "User-Agent": "OpsHub/3.0" } }
    );
    const xml = await r.text();
    const events = parseFF(xml);
    if (events.length) {
      try {
        await kvSet(db, "ffcal", { t: Date.now() / 1e3, events });
      } catch (e) {
      }
      return events;
    }
  } catch (e) {
  }
  try {
    const raw2 = await kvGet(db, "ffcal");
    if (raw2) return JSON.parse(raw2).events || [];
  } catch (e) {
  }
  return [];
}
function ffEventLine(e, settings) {
  const cur = CURRENCIES[e.country] || "";
  const time = fmtClock(e.ts, settings.tz);
  const bits = [];
  if (e.actual) bits.push(`actual ${e.actual}`);
  if (e.forecast) bits.push(`f ${e.forecast}`);
  if (e.previous) bits.push(`p ${e.previous}`);
  const suffix = bits.length ? ` (${bits.join(" \xB7 ")})` : "";
  const flag = e.impact === "High" ? "\u{1F6A8}" : e.impact === "Medium" ? "\u{1F7E1}" : "\u26AA\uFE0F";
  return `\u2022 ${time} ${cur || e.country} \u2014 ${e.title} ${flag}${e.impact ? ` ${e.impact}` : ""}${suffix}`;
}
function sameLocalDay(epoch, tz) {
  return localParts(new Date(epoch * 1e3), tz).date === localParts(/* @__PURE__ */ new Date(), tz).date;
}
async function newsBlock(ctx, settings, opts) {
  opts = opts || {};
  const events = await getFF(ctx, opts.force);
  const now = Math.floor(Date.now() / 1e3);
  const upcoming = events.filter((e) => e.ts >= now && (!opts.todayOnly || sameLocalDay(e.ts, settings.tz))).slice(0, opts.limit || 6);
  const released = events.filter((e) => e.ts < now && e.actual && (!opts.todayOnly || sameLocalDay(e.ts, settings.tz))).slice(-3);
  let out = "\u{1F4F0} Forex news (times in " + settings.place + " time):\n";
  if (upcoming.length) {
    out += "Upcoming:\n" + upcoming.map((e) => ffEventLine(e, settings)).join("\n") + "\n";
  }
  if (released.length) {
    out += "Just released:\n" + released.map((e) => ffEventLine(e, settings)).join("\n");
  }
  if (!upcoming.length && !released.length) out += "(no events found)";
  return out;
}
async function newsAlerts(ctx) {
  const db = ctx.env.DB;
  const settings = await getSettings(db);
  const now = Math.floor(Date.now() / 1e3);
  const events = await getFF(ctx);
  let sent = 0;
  for (const e of events) {
    if (e.impact !== "High") continue;
    const delta = e.ts - now;
    if (delta <= 0 || delta > 45 * 60) continue;
    const key = "ffalert:" + e.ts + ":" + e.title.slice(0, 40);
    try {
      const seen = await kvGet(db, key);
      if (seen) continue;
      const mins = Math.round(delta / 60);
      const cur = CURRENCIES[e.country] || e.country;
      const bits = [];
      if (e.forecast) bits.push(`Forecast ${e.forecast}`);
      if (e.previous) bits.push(`Prev ${e.previous}`);
      const text = `\u{1F6A8} HIGH IMPACT in ${mins}m (${fmtClock(e.ts, settings.tz)} ${settings.place})
${cur} \u2014 ${e.title}
` + (bits.length ? bits.join(" \xB7 ") + "\n" : "") + `Avoid new entries until after the release. Ask me /news afterwards.`;
      const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
      const ownerRow = await kvGet(db, "report_owner");
      const owner = ownerRow ? JSON.parse(ownerRow).chat : null;
      if (botToken && owner) {
        await sendTelegram(botToken, owner, text);
        await kvSet(db, key, now);
        sent++;
      }
    } catch (e2) {
    }
  }
  try {
    await db.prepare("DELETE FROM kv WHERE k LIKE 'ffalert:%' AND CAST(v AS INTEGER) < ?").bind(now - 43200).run();
  } catch (e) {
  }
  return sent;
}
function stripXml(s) {
  const A = "&";
  let out = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  out = out.replace(/&([a-zA-Z]+);/g, (m, n) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: A })[n] || m);
  return out.replace(/\s+/g, " ").trim();
}
async function getHeadlines(ctx, force) {
  const db = ctx.env.DB;
  if (!force) {
    try {
      const raw2 = await kvGet(db, "headlines");
      if (raw2) {
        const h2 = JSON.parse(raw2);
        if (Date.now() / 1e3 - h2.t < HEADLINES_TTL_S && h2.items?.length) return h2;
      }
    } catch (e) {
    }
  }
  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const r = await fetch(f.url, {
        signal: AbortSignal.timeout(7e3),
        headers: { "User-Agent": "OpsHub/3.0 (personal news reader)" }
      });
      const xml = await r.text();
      const items2 = [];
      const chunks = xml.split(/<item[\s>]/).slice(1);
      for (const c of chunks.slice(0, 4)) {
        const title = (c.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1];
        const link = (c.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1];
        const pub = (c.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1];
        if (!title) continue;
        const parsed = pub ? Date.parse(stripXml(pub)) : NaN;
        items2.push({
          feed: f.name,
          title: stripXml(title),
          link: stripXml(link || ""),
          at: Number.isFinite(parsed) ? parsed : 0
        });
      }
      if (!items2.length) throw new Error("empty feed " + f.name);
      return items2;
    })
  );
  const items = [];
  const okFeeds = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      okFeeds.push(FEEDS[i].name);
      items.push(...r.value);
    }
  });
  const h = { t: Date.now() / 1e3, feeds: okFeeds, items: items.slice(0, 14) };
  try {
    await kvSet(db, "headlines", h);
  } catch (e) {
  }
  return h;
}
function headlinesText(h, limit) {
  if (!h || !h.items || !h.items.length) return "Headlines unavailable right now.";
  const seen = /* @__PURE__ */ new Set();
  const lines = [];
  for (const it of h.items) {
    if (seen.has(it.title)) continue;
    seen.add(it.title);
    lines.push(`\u2022 [${it.feed}] ${it.title}`);
    if (lines.length >= (limit || 10)) break;
  }
  return "Headlines (" + h.feeds.join(", ") + "):\n" + lines.join("\n");
}
var COUNTRY_TZ = {
  Cyprus: "Europe/Nicosia",
  Turkey: "Europe/Istanbul",
  "T\xFCrkiye": "Europe/Istanbul",
  Greece: "Europe/Athens",
  "United Kingdom": "Europe/London",
  Germany: "Europe/Berlin",
  France: "Europe/Paris",
  Spain: "Europe/Madrid",
  Italy: "Europe/Rome",
  Portugal: "Europe/Lisbon",
  Netherlands: "Europe/Amsterdam",
  Belgium: "Europe/Brussels",
  Austria: "Europe/Vienna",
  Switzerland: "Europe/Zurich",
  Sweden: "Europe/Stockholm",
  Norway: "Europe/Oslo",
  Denmark: "Europe/Copenhagen",
  Finland: "Europe/Helsinki",
  Poland: "Europe/Warsaw",
  Czechia: "Europe/Prague",
  "Czech Republic": "Europe/Prague",
  Hungary: "Europe/Budapest",
  Romania: "Europe/Bucharest",
  Bulgaria: "Europe/Sofia",
  Ireland: "Europe/Dublin",
  Russia: "Europe/Moscow",
  Ukraine: "Europe/Kyiv",
  Israel: "Asia/Jerusalem",
  Lebanon: "Asia/Beirut",
  Jordan: "Asia/Amman",
  "Saudi Arabia": "Asia/Riyadh",
  Qatar: "Asia/Qatar",
  "United Arab Emirates": "Asia/Dubai",
  Egypt: "Africa/Cairo",
  Nigeria: "Africa/Lagos",
  Kenya: "Africa/Nairobi",
  "South Africa": "Africa/Johannesburg",
  "United States": "America/New_York",
  Canada: "America/Toronto",
  Mexico: "America/Mexico_City",
  Brazil: "America/Sao_Paulo",
  Argentina: "America/Argentina/Buenos_Aires",
  India: "Asia/Kolkata",
  Pakistan: "Asia/Karachi",
  China: "Asia/Shanghai",
  Japan: "Asia/Tokyo",
  "South Korea": "Asia/Seoul",
  Singapore: "Asia/Singapore",
  Thailand: "Asia/Bangkok",
  Malaysia: "Asia/Kuala_Lumpur",
  Indonesia: "Asia/Jakarta",
  Vietnam: "Asia/Ho_Chi_Minh",
  Philippines: "Asia/Manila",
  Australia: "Australia/Sydney",
  "New Zealand": "Pacific/Auckland",
  Iran: "Asia/Tehran",
  Iraq: "Asia/Baghdad",
  Kazakhstan: "Asia/Almaty"
};
async function lookupTz(q, countryEn) {
  let omCountry = null;
  try {
    const r = await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + encodeURIComponent(q),
      { signal: AbortSignal.timeout(6e3) }
    );
    const j = await r.json();
    const first = j.results && j.results[0];
    if (first) {
      omCountry = first.country || null;
      if (first.timezone && tzValid(first.timezone)) return first.timezone;
    }
  } catch (e) {
  }
  const mapped = COUNTRY_TZ[String(countryEn || "").trim()] || COUNTRY_TZ[String(omCountry || "").trim()];
  return mapped && tzValid(mapped) ? mapped : null;
}
async function geocode(q) {
  try {
    const r = await fetch(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q=" + encodeURIComponent(q),
      {
        headers: { "User-Agent": "OpsHub/3.0 personal Telegram assistant", "Accept": "application/json" },
        signal: AbortSignal.timeout(8e3)
      }
    );
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || ct.indexOf("json") === -1) return null;
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j) || !j.length) return null;
    const g = j[0];
    return {
      label: g.display_name,
      lat: parseFloat(g.lat),
      lon: parseFloat(g.lon),
      type: (g.addresstype || g.type || "").toString(),
      country: g.address && (g.address.country || "") || ""
    };
  } catch (e) {
    return null;
  }
}
function fmtMeters(m) {
  return m < 1e3 ? `${Math.round(m)} m` : `${(m / 1e3).toFixed(1)} km`;
}
function fmtSeconds(s) {
  if (s < 90) return `${Math.round(s / 60) * 60 === 0 ? 1 : Math.round(s / 60)} min`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round(s % 3600 / 60);
  return `${h}h ${m}m`;
}
async function osrmRoute(a, b, walk) {
  const providers = walk ? ["https://routing.openstreetmap.de/routed-foot/route/v1/driving"] : [
    "https://router.project-osrm.org/route/v1/driving",
    "https://routing.openstreetmap.de/routed-car/route/v1/driving"
  ];
  for (const base of providers) {
    try {
      const url = `${base}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false&steps=true&alternatives=false`;
      const r = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "OpsHub/3.0" },
        signal: AbortSignal.timeout(9e3)
      });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || ct.indexOf("json") === -1) continue;
      const j = await r.json().catch(() => null);
      if (!j || j.code !== "Ok" || !j.routes || !j.routes.length) continue;
      const rt = j.routes[0];
      const steps = [];
      for (const leg of rt.legs) {
        for (const s of leg.steps || []) {
          const mv = s.maneuver || {};
          const road = s.name ? ` onto ${s.name}` : "";
          let t = "";
          if (mv.type === "depart") t = `Head ${mv.modifier || "out"}${road}`;
          else if (mv.type === "arrive") t = "Arrive at destination";
          else if (mv.type === "roundabout" || mv.type === "rotary") t = `Take the roundabout${road}`;
          else if (mv.type === "merge") t = `Merge${road}`;
          else if (mv.type === "on ramp") t = `Take the ramp${road}`;
          else if (mv.type === "off ramp") t = `Take the exit${road}`;
          else if (mv.type === "fork") t = `Keep ${mv.modifier || "left"} at the fork${road}`;
          else if (mv.type === "new name") t = `Continue${road}`;
          else if (mv.type === "turn") t = `Turn ${mv.modifier || ""}${road}`.trim();
          else if (mv.type === "continue" || mv.type === "end of road") t = `Continue${road}`;
          else t = `${mv.type || "Go"}${road}`;
          if (t && steps.length < 12) steps.push(t.replace(/\s+/g, " "));
        }
      }
      return { dist: rt.distance, dur: rt.duration, steps };
    } catch (e) {
    }
  }
  return null;
}
async function directionsText(fromQ, toQ, walk, settings) {
  const a = await geocode(fromQ);
  if (!a) return `Couldn't find "${fromQ}". Try /directions <place> to <place>.`;
  const b = await geocode(toQ);
  if (!b) return `Couldn't find "${toQ}". Try /directions <place> to <place>.`;
  const rt = await osrmRoute(a, b, walk);
  if (!rt) return `No route found between ${a.label} and ${b.label} right now.`;
  const mode = walk ? "\u{1F6B6} walking" : "\u{1F697} driving";
  return `${mode}: ${a.label.split(",")[0]} \u2192 ${b.label.split(",")[0]}
${fmtMeters(rt.dist)} \xB7 about ${fmtSeconds(rt.dur)}

` + rt.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
}
async function areaText(q) {
  const g = await geocode(q);
  if (!g) return `Couldn't find "${q}".`;
  let extra = "";
  try {
    const r = await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + encodeURIComponent(q),
      { signal: AbortSignal.timeout(6e3) }
    );
    const j = await r.json();
    const f = j.results && j.results[0];
    if (f) {
      if (f.population) extra += ` \xB7 pop ~${Number(f.population).toLocaleString("en")}`;
      const tz = f.timezone && tzValid(f.timezone) ? f.timezone : COUNTRY_TZ[String(f.country || "").trim()];
      if (tz) {
        const pp = localParts(/* @__PURE__ */ new Date(), tz);
        extra += `
local time there: ${pp.hhmm} ${pp.weekday} (${tz})`;
      }
    }
  } catch (e) {
  }
  let profile = "";
  const mirrors = ["https://overpass-api.de/api/interpreter"];
  for (const mirror of mirrors) {
    try {
      const cats = [
        ["schools", 'nwr(around:900,LAT,LON)["amenity"="school"]'],
        ["hospitals/clinics", 'nwr(around:1500,LAT,LON)["amenity"~"hospital|clinic"]'],
        ["cafes/restaurants", 'nwr(around:700,LAT,LON)["amenity"~"cafe|restaurant|bar|fast_food"]'],
        ["supermarkets", 'nwr(around:900,LAT,LON)["shop"~"supermarket|convenience"]'],
        ["parks", 'nwr(around:1500,LAT,LON)["leisure"="park"]'],
        ["pharmacies", 'nwr(around:700,LAT,LON)["amenity"="pharmacy"]']
      ];
      const body = "[out:json][timeout:12];" + cats.map(([_, q2]) => q2.replace("LAT", g.lat).replace("LON", g.lon) + ";out count;").join("");
      const r = await fetch(mirror, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": "OpsHub/3.0 personal Telegram assistant"
        },
        body: "data=" + encodeURIComponent(body),
        signal: AbortSignal.timeout(8e3)
      });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || ct.indexOf("json") === -1) continue;
      const j2 = await r.json().catch(() => null);
      if (!j2 || !Array.isArray(j2.elements)) continue;
      const counts = j2.elements.map((e) => {
        const n = (e.tags && (e.tags.total ?? e.tags.total_count)) ?? e.total ?? 0;
        return Number(n) || 0;
      });
      const icons = ["\u{1F3EB}", "\u{1F3E5}", "\u2615\uFE0F", "\u{1F6D2}", "\u{1F333}", "\u{1F48A}"];
      profile = cats.map(([name], i2) => `${icons[i2]} ${counts[i2] ?? 0} ${name}`).join(" \xB7 ");
      break;
    } catch (e) {
    }
  }
  if (!profile) profile = "(nearby-places lookup unavailable)";
  return `\u{1F4CD} ${g.label}
type: ${g.type}${g.country ? ` \xB7 ${g.country}` : ""}${extra}
coords: ${g.lat.toFixed(4)}, ${g.lon.toFixed(4)}
nearby: ${profile}`;
}
async function repoStatuses(ctx) {
  const db = ctx.env.DB;
  const token = ctx.env.HUB_GITHUB_TOKEN;
  const owner = ctx.env.GITHUB_OWNER || "landryparadis012-git";
  if (!token) return null;
  try {
    const hit = await kvGet(db, "repostatus");
    if (hit) {
      const parsed = JSON.parse(hit);
      if (Date.now() / 1e3 - parsed.t < REPORT_TTL_S) return parsed.data;
    }
  } catch (e) {
  }
  const out = [];
  for (const name of REPO_NAMES) {
    try {
      const j = await ghGet(`/repos/${owner}/${name}/actions/runs?per_page=1`, token);
      const run = j.workflow_runs && j.workflow_runs[0];
      out.push(
        run ? {
          repo: name,
          wf: run.name || "?",
          state: run.status,
          result: run.conclusion || (run.status === "in_progress" ? "running" : "-"),
          at: run.updated_at,
          url: run.html_url
        } : { repo: name, wf: "-", state: "none", result: "no runs", at: "", url: "" }
      );
    } catch (e) {
      out.push({ repo: name, wf: "-", state: "error", result: String(e).slice(0, 60), at: "", url: "" });
    }
  }
  try {
    await kvSet(db, "repostatus", { t: Date.now() / 1e3, data: out });
  } catch (e) {
  }
  return out;
}
function ago(iso) {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1e3;
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}
function iconFor(result, state) {
  if (state === "in_progress" || state === "queued") return "\u{1F504}";
  if (result === "success") return "\u2705";
  if (result === "failure" || result === "timed_out" || result === "cancelled") return "\u274C";
  return "\u2022";
}
async function buildReport(ctx, chatId, mode, settings) {
  mode = mode || "daily";
  const db = ctx.env.DB;
  const statuses = await repoStatuses(ctx) || [];
  const now = localParts(/* @__PURE__ */ new Date(), settings.tz);
  const head = mode === "morning" ? `\u2600\uFE0F MORNING BRIEF \u2014 ${now.date}` : mode === "evening" ? `\u{1F319} DAY REPORT \u2014 ${now.date}` : `\u{1F4CA} OpsHub Daily Report \u2014 ${now.date}`;
  let out = `${head}
(${settings.place} time ${now.hhmm} \xB7 ${settings.tz})

\u{1F528} Studio runs:
`;
  const todos = [];
  for (const s of statuses) {
    out += `${iconFor(s.result, s.state)} ${s.repo} \u2014 ${s.result}${s.at ? ` (${ago(s.at)})` : ""}
`;
    if (s.result === "failure" || s.result === "timed_out" || s.result === "cancelled") {
      todos.push(`Check ${s.repo} \u2014 last run ${s.result}`);
    }
    if (s.state === "none" || s.result === "no runs") {
      todos.push(`Trigger ${s.repo} \u2014 it has never run`);
    }
  }
  try {
    const dayStart = zonedDayStart(Date.now(), settings.tz);
    const evRows = await db.prepare(
      "SELECT type, payload FROM events WHERE type LIKE 'trade.%' ORDER BY received_at DESC LIMIT 300"
    ).all();
    const openMap = {};
    let closedR = 0, closedN = 0;
    for (const row of evRows.results || []) {
      let p = {};
      try {
        p = JSON.parse(row.payload);
      } catch (_) {
      }
      const tid = p.trade_id || "";
      if (!tid) continue;
      if (row.type === "trade.opened") {
        if (!(tid in openMap)) openMap[tid] = p;
      } else if (row.type === "trade.closed") {
        delete openMap[tid];
        const rr = Number(p.realized_r);
        if (Number.isFinite(rr) && (p.occurred_at || 0) >= dayStart) {
          closedN++;
          closedR += rr;
        }
      }
    }
    const openList = Object.values(openMap);
    out += `
\u{1F4C8} Trading
\u2022 open: ${openList.length}` + (openList.length ? " (" + openList.map((t) => `${t.symbol || "?"} ${t.side || ""}`).join(", ") + ")" : "") + ` \xB7 closed today: ${closedN}${closedN ? `, ${closedR >= 0 ? "+" : ""}${closedR.toFixed(2)}R` : ""}
`;
  } catch (e) {
  }
  try {
    const w = await getWeather(ctx, settings);
    const wl = weatherLine(w, settings);
    if (wl) out += `
\u{1F324} Weather
\u2022 ${wl}
`;
  } catch (e) {
  }
  try {
    const events = await getFF(ctx);
    const nowS = Math.floor(Date.now() / 1e3);
    const up = events.filter((e) => e.ts >= nowS && sameLocalDay(e.ts, settings.tz) && e.impact === "High").slice(0, 3);
    const rel = events.filter((e) => e.ts < nowS && e.actual && sameLocalDay(e.ts, settings.tz)).slice(-2);
    if (up.length || rel.length) {
      out += `
\u26A0\uFE0F News (high impact, ${settings.place} time):
`;
      for (const e of up) {
        out += `\u2022 ${fmtClock(e.ts, settings.tz)} ${CURRENCIES[e.country] || e.country} \u2014 ${e.title}${e.forecast ? ` (f ${e.forecast} \xB7 p ${e.previous})` : ""}
`;
        const delta = e.ts - nowS;
        if (delta < 5400) todos.push(`${e.title} in ${Math.round(delta / 60)}m \u2014 no new entries before it`);
      }
      for (const e of rel) {
        out += `\u2022 released ${fmtClock(e.ts, settings.tz)} ${CURRENCIES[e.country] || e.country} \u2014 ${e.title}: actual ${e.actual}${e.forecast ? ` vs f ${e.forecast}` : ""}
`;
      }
    }
  } catch (e) {
  }
  let rows = [];
  try {
    rows = await listReminders(db, chatId);
  } catch (e) {
  }
  const soon = Math.floor(Date.now() / 1e3) + 86400;
  const dueSoon = rows.filter((r) => r.due_at <= soon);
  out += `
\u23F0 Reminders (next 24h):
`;
  out += dueSoon.length ? dueSoon.map((r) => `\u2022 #${r.id} ${fmtDue(r.due_at, settings)} \u2014 ${r.text}`).join("\n") : "\u2022 none";
  try {
    const rec = await db.prepare("SELECT repo, series, episode, dispatched_at FROM dispatched ORDER BY id DESC LIMIT 5").all();
    const recs = rec.results || [];
    if (recs.length) {
      out += `

\u{1F4E4} Recent dispatches:
`;
      out += recs.map(
        (r) => `\u2022 ${r.repo}${r.series ? ` : ${r.series}` : ""}${r.episode ? ` ep${r.episode}` : ""} (${ago(r.dispatched_at)})`
      ).join("\n");
    }
  } catch (e) {
  }
  const todoHead = mode === "evening" ? "\u{1F4CC} First thing tomorrow" : "\u2705 Do first";
  if (todos.length) {
    out += `

${todoHead}:
` + todos.map((t, i) => `${i + 1}. ${t}`).join("\n");
  } else {
    out += `

${todoHead}:
\u2022 All green \u2014 nothing needs you today.`;
  }
  return out.slice(0, 4e3);
}
async function aiContext(db, chatId, settings, statuses, reminders) {
  const now = localParts(/* @__PURE__ */ new Date(), settings.tz);
  const [w, headlines, cal, log] = await Promise.all([
    getWeather({ env: { DB: db } }, settings).catch(() => null),
    getHeadlines({ env: { DB: db } }).catch(() => ({ items: [], feeds: [] })),
    getFF({ env: { DB: db } }).catch(() => []),
    getChatLog(db, chatId)
  ]);
  const runLine = (statuses || []).map((s) => `${s.repo}: ${s.result}${s.at ? ` (${ago(s.at)})` : ""}`).join("; ");
  const remLine = reminders.length ? reminders.map(
    (r) => `#${r.id} ${fmtDue(r.due_at, settings)}${repeatLabel(r.repeat_h)}: "${r.text}"`
  ).join("; ") : "none";
  const nowS = Math.floor(Date.now() / 1e3);
  const upcoming = cal.filter((e) => e.ts >= nowS && e.ts < nowS + 86400 && e.impact === "High").slice(0, 6).map((e) => ffEventLine(e, settings)).join("\n  ");
  const released = cal.filter((e) => e.ts < nowS && e.ts > nowS - 86400 && e.actual).slice(-3).map((e) => ffEventLine(e, settings)).join("\n  ");
  const heads = (headlines.items || []).slice(0, 8).map((h) => `[${h.feed}] ${h.title}`).join("\n  ");
  const history = log.map((m) => `${m.r === "user" ? "User" : "OpsHub"}: ${m.t}`).join("\n  ");
  return `LIVE CONTEXT (real \u2014 never invent beyond this):
- Now: ${now.weekday} ${now.date} ${now.hhmm} in ${settings.place} (${settings.tz})
- Weather: ${weatherLine(w, settings) || "unavailable"}
- Forex news \u2014 upcoming 24h (High impact, ${settings.place} time):
  ${upcoming || "none listed"}
- Released last 24h:
  ${released || "none"}
- Headlines (${(headlines.feeds || []).join(", ") || "none"}):
  ${heads || "none"}
- Active reminders: ${remLine}
- Latest GitHub run per repo: ${runLine || "unavailable"}
- Recent chat:
  ${history || "(empty)"}`;
}
function aiRules(settings) {
  return `RULES:
- All times you mention are in ${settings.tz} \u2014 ${settings.place} local \u2014 matching LIVE CONTEXT.
- Reports and to-do lists: answer ONLY from LIVE CONTEXT. Never invent tasks, metrics, news, prices or headlines; if something isn't in context, say you don't have it.
- Trading: factor the news calendar in. Warn against opening positions within 30 minutes before a High-impact release; after releases, reason from actual vs forecast values shown. Keep it factual.
- The user lives in / travels to different places: if they say they are now in / moved to / landed in <place>, or ask you to remember where they are, reply with ONLY this line: WHERE:<place>
- If they ask to set/confirm the timezone, reply ONLY: TZ:<IANA name>
- If they ask about the weather, reply ONLY: WEATHER:
- If they ask for directions or how to get somewhere, reply ONLY: DIRECTIONS:<from> to <to> (use their saved place as <from> when they don't say it; mention walking only if they asked to walk)
- If they ask about an area / neighborhood / what's around somewhere, reply ONLY: AREA:<place>
- If they ask what news is coming out / forex calendar / any economic events, reply ONLY: NEWS:
- If they ask for news headlines / articles / "what's in the news", reply ONLY: HEADLINES:
- ONLY when the user explicitly asks to delete/cancel/remove an EXISTING reminder, reply ONLY: DELETE:<id> (pick the id from Active reminders; "it"/"that" with one obvious candidate \u2192 that id; if none exist, reply normally that there are no reminders).
- ONLY when the user asks for a reminder within hours/days ("in 2 hours", "tomorrow in 3h"), reply ONLY: REMIND:<hours>:<repeat_h or 0>:<text>
- ONLY when the user asks for a reminder at a clock time ("at 15:30", "every day at 08:00", "every Monday 09:00" \u2192 next occurrence), reply ONLY: REMINDAT:<YYYY-MM-DD HH:MM>:<repeat_h or 0>:<text> \u2014 compute the date/time in ${settings.tz}; use repeat 1440 for daily, 0 for once.
- If you emit a protocol line, emit NOTHING else (one line only).
- Otherwise: concise, friendly, plain text. Max 150 words. No markdown tables.`;
}
async function runProtocol(aiReply, chatId, ctx, settings) {
  const db = ctx.env.DB;
  const actions = [];
  const send = (s) => actions.push(s);
  let remaining = String(aiReply || "");
  const del = remaining.match(/^\s*DELETE:\s*(\d+)\s*$/m);
  const rem = remaining.match(/^\s*REMIND:\s*([\d.]+):(\d*):(.+)$/m);
  const remAt = remaining.match(/^\s*REMINDAT:\s*([^\s:]+(?:\s+\d{1,2}:\d{2})):(\d*):(.+)$/m);
  const where = remaining.match(/^\s*WHERE:\s*(.+)$/m);
  const tz = remaining.match(/^\s*TZ:\s*(\S+)$/m);
  const wantsWeather = /^\s*WEATHER:\s*$/m.test(remaining);
  const wantsNews = /^\s*NEWS:\s*$/m.test(remaining);
  const wantsHeads = /^\s*HEADLINES:\s*$/m.test(remaining);
  const dir = remaining.match(/^\s*DIRECTIONS:\s*(.+?)\s+to\s+(.+)$/m);
  const area = remaining.match(/^\s*AREA:\s*(.+)$/m);
  let acted = false;
  if (del && actions.length < 2) {
    acted = true;
    try {
      const row = await deleteReminder(db, chatId, parseInt(del[1], 10));
      send(row ? `\u2705 Reminder #${row.id} cancelled: "${row.text}"` : `No active reminder #${del[1]}. /reminders shows what's active.`);
    } catch (e) {
      send("Could not delete: " + String(e).slice(0, 100));
    }
  } else if (rem && actions.length < 2) {
    acted = true;
    try {
      const hours = parseFloat(rem[1]);
      const repeatH = parseInt(rem[2] || "0", 10) || 0;
      const body = rem[3].trim();
      const r = await addReminder(db, chatId, body, hours, repeatH);
      send(`\u2705 Reminder #${r.id} set for ${fmtClock(r.due, settings.tz)} ${settings.place} time${repeatLabel(repeatH)}:
"${body}"`);
    } catch (e) {
      send("Could not store reminder: " + String(e).slice(0, 100));
    }
  } else if (remAt && actions.length < 2) {
    acted = true;
    try {
      const when = remAt[1].trim();
      const repeatH = parseInt(remAt[2] || "0", 10) || 0;
      const body = remAt[3].trim();
      let epoch = zonedTimeToEpoch(when, settings.tz);
      if (epoch == null) {
        send(`Couldn't read the time "${when}". Say e.g. "at 15:30" or "every day at 08:00".`);
      } else {
        const nowS = Math.floor(Date.now() / 1e3);
        if (epoch <= nowS) {
          if (repeatH > 0) {
            while (epoch <= nowS) epoch += repeatH * 3600;
          } else {
            send(`That time (${when}) already passed in ${settings.place}. Give a future time.`);
            epoch = null;
          }
        }
        if (epoch) {
          const r = await addReminder(db, chatId, body, (epoch - nowS) / 3600, repeatH, epoch);
          send(`\u2705 Reminder #${r.id} set for ${fmtClock(r.due, settings.tz)} ${settings.place} time${repeatLabel(repeatH)}:
"${body}"`);
        }
      }
    } catch (e) {
      send("Could not store reminder: " + String(e).slice(0, 100));
    }
  }
  if (where && actions.length < 2) {
    acted = true;
    const placeQ = where[1].trim().replace(/[.!?]+$/, "");
    try {
      const geo = await geocode(placeQ);
      if (geo) {
        const tzOf = await lookupTz(placeQ, geo.country);
        const s2 = await saveSettings(db, {
          place: geo.label.split(",")[0].trim(),
          lat: geo.lat,
          lon: geo.lon,
          ...tzOf && tzValid(tzOf) ? { tz: tzOf } : {}
        });
        const p = localParts(/* @__PURE__ */ new Date(), s2.tz);
        send(`\u{1F4CD} Location updated: ${s2.place} (${s2.lat.toFixed(2)}, ${s2.lon.toFixed(2)})
Timezone: ${s2.tz} \u2014 local time now ${p.hhmm}.
Weather, report windows and news alerts all shifted with you.`);
      } else {
        send(`Couldn't find "${placeQ}" \u2014 give me a clearer place name (city + country).`);
      }
    } catch (e) {
      send("Location update failed: " + String(e).slice(0, 100));
    }
  }
  if (tz && actions.length < 2) {
    acted = true;
    const z = tz[1].trim();
    if (tzValid(z)) {
      const s2 = await saveSettings(db, { tz: z });
      const p = localParts(/* @__PURE__ */ new Date(), s2.tz);
      send(`\u2705 Timezone set to ${z} \u2014 local time now ${p.hhmm} (${p.weekday} ${p.date}).`);
    } else {
      send(`"${z}" isn't a valid timezone. Example: Europe/Nicosia, Europe/Istanbul, Asia/Dubai.`);
    }
  }
  if (wantsWeather && actions.length < 2) {
    acted = true;
    send(await weatherTextCmd(ctx, settings));
  }
  if (wantsNews && actions.length < 2) {
    acted = true;
    send(await newsBlock(ctx, settings, { limit: 8 }));
  }
  if (wantsHeads && actions.length < 2) {
    acted = true;
    const h = await getHeadlines(ctx, true).catch(() => null);
    send(headlinesText(h, 10));
  }
  if (dir && actions.length < 2) {
    acted = true;
    const from = dir[1].trim() || settings.place;
    send(await directionsText(from, dir[2].trim(), /walk/i.test(from + " " + dir[2]), settings));
  }
  if (area && actions.length < 2) {
    acted = true;
    send(await areaText(area[1].trim()));
  }
  if (!acted) return { text: aiReply, acted: false };
  const stripped = remaining.split("\n").filter((l) => !/^\s*(DELETE|REMIND|REMINDAT|WHERE|TZ|WEATHER|NEWS|HEADLINES|DIRECTIONS|AREA)\s*:/i.test(l)).join("\n").trim();
  const parts = actions.slice(0, 2);
  if (stripped.length > 3) parts.push(stripped);
  return { text: parts.join("\n\n"), acted: true };
}
async function handleCommand(text, chatId, ctx, settings) {
  const db = ctx.env.DB;
  if (text === "/repos") {
    return "Registered repos:\n" + REPOS.map((r) => `\u2022 ${r.name} (${r.event})`).join("\n");
  }
  if (text === "/status") {
    return `Hub status: OK
Version: ${VERSION}
Mode: Telegram-first
Location: ${settings.place} (${settings.tz})
Local time: ${localParts(/* @__PURE__ */ new Date(), settings.tz).hhmm}
Reminders: D1-backed (swept every 5m by Convex cron)
News alerts: 45m before High impact`;
  }
  if (text === "/report" || text === "/daily") {
    try {
      const cur = await kvGet(db, "report_owner");
      if (!cur) await kvSet(db, "report_owner", { chat: String(chatId), setAt: Date.now() });
    } catch (e) {
    }
    return buildReport(ctx, chatId, "daily", settings);
  }
  if (text === "/reminders") {
    try {
      return remindersText(await listReminders(db, chatId), settings);
    } catch (e) {
      return "Reminders unavailable: " + String(e).slice(0, 120);
    }
  }
  if (/^\/remind\s+\d+/.test(text)) {
    const m = text.match(/^\/remind\s+(\d+(?:\.\d+)?)\s+(?:every\s+)?(.+)$/);
    if (!m) return "Usage:\n/remind 48 <text>\n/remind 24 every <text>";
    const hours = parseFloat(m[1]);
    const body = m[2].trim();
    const repeat = /\bevery\b/.test(text);
    try {
      const r = await addReminder(db, chatId, body, hours, repeat ? Math.max(1, Math.round(hours)) : 0);
      return `\u2705 Reminder #${r.id} set${repeat ? ` (repeats every ${Math.round(hours)}h)` : ""} for ${fmtClock(r.due, settings.tz)} ${settings.place} time:
"${body}"`;
    } catch (e) {
      return "Could not store reminder: " + String(e).slice(0, 120);
    }
  }
  if (/^\/delete\s+\d+/.test(text)) {
    const id = parseInt(text.match(/^\/delete\s+(\d+)/)[1], 10);
    try {
      const row = await deleteReminder(db, chatId, id);
      return row ? `\u2705 Reminder #${id} cancelled: "${row.text}"` : `No active reminder #${id}. Use /reminders to see active ones.`;
    } catch (e) {
      return "Could not delete: " + String(e).slice(0, 120);
    }
  }
  if (text.startsWith("/forget ")) {
    const chain = text.substring(8).trim();
    try {
      const res = await db.prepare("DELETE FROM dispatched WHERE series = ? OR repo = ?").bind(chain, chain).run();
      const n = res.meta && res.meta.changes || 0;
      return n ? `\u2705 Chain "${chain}" forgotten \u2014 ${n} dispatch record(s) cleared; it can fire again.` : `Nothing found for chain "${chain}".`;
    } catch (e) {
      return "Could not forget: " + String(e).slice(0, 120);
    }
  }
  if (text === "/weather") return weatherTextCmd(ctx, settings);
  if (text === "/news") return newsBlock(ctx, settings, { limit: 8 });
  if (text === "/headlines") {
    const h = await getHeadlines(ctx, false).catch(() => null);
    return headlinesText(h, 10);
  }
  if (/^\/time\b/.test(text)) {
    const arg = text.replace(/^\/time\s*/, "").trim();
    if (!arg) {
      const p2 = localParts(/* @__PURE__ */ new Date(), settings.tz);
      return `\u{1F550} ${p2.hhmm} ${p2.weekday} ${p2.date} \u2014 ${settings.place} (${settings.tz})`;
    }
    const g = await (async () => {
      try {
        const r = await fetch(
          "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + encodeURIComponent(arg),
          { signal: abort2(6e3) }
        );
        const j = await r.json();
        return j.results && j.results[0] ? j.results[0] : null;
      } catch (e) {
        return null;
      }
    })();
    if (!g) return `Couldn't find "${arg}".`;
    const tzOf = g.timezone && tzValid(g.timezone) ? g.timezone : COUNTRY_TZ[String(g.country || "").trim()];
    if (!tzOf) return `Found ${g.name}${g.country ? `, ${g.country}` : ""} but couldn't detect its timezone. Coordinates: ${g.latitude}, ${g.longitude}`;
    const p = localParts(/* @__PURE__ */ new Date(), tzOf);
    return `\u{1F550} ${p.hhmm} ${p.weekday} ${p.date} in ${g.name}${g.country ? `, ${g.country}` : ""} (${tzOf})`;
  }
  if (/^\/tz\b/.test(text)) {
    const z = text.replace(/^\/tz\s*/, "").trim();
    if (!z) return `Current timezone: ${settings.tz}. Set with /tz Europe/Istanbul`;
    if (!tzValid(z)) return `"${z}" isn't a valid timezone. Example: /tz Europe/Istanbul`;
    await saveSettings(db, { tz: z });
    const p = localParts(/* @__PURE__ */ new Date(), z);
    return `\u2705 Timezone: ${z} \u2014 local time now ${p.hhmm} (${p.weekday} ${p.date}).`;
  }
  if (/^\/where\b/.test(text)) {
    const q = text.replace(/^\/where\s*/, "").trim();
    if (!q) {
      return `Current location: ${settings.place} (${settings.lat}, ${settings.lon}) \xB7 ${settings.tz}
Set a new one with /where <city or place>`;
    }
    const geo = await geocode(q);
    if (!geo) return `Couldn't find "${q}". Try /where Limassol or /where "Berlin, Germany".`;
    const tzOf = await lookupTz(q, geo.country);
    const s2 = await saveSettings(db, {
      place: geo.label.split(",")[0].trim(),
      lat: geo.lat,
      lon: geo.lon,
      ...tzOf ? { tz: tzOf } : {}
    });
    const p = localParts(/* @__PURE__ */ new Date(), s2.tz);
    const warn = tzOf ? "" : "\n\u26A0\uFE0F Could not auto-detect the timezone \u2014 set it with /tz <IANA> (e.g. /tz Europe/Nicosia).";
    return `\u{1F4CD} Location: ${geo.label}
Timezone ${s2.tz} \u2014 local time ${p.hhmm}. Weather, times and news alerts now follow this place.${warn}`;
  }
  if (/^\/(directions|nav)\b/.test(text)) {
    const arg = text.replace(/^\/(directions|nav)\s*/, "").trim();
    if (!arg) return "Usage: /directions <from> to <to>\nExample: /directions Nicosia to Limassol";
    const m = arg.match(/^(.+?)\s+(?:to|->|→)\s+(.+)$/);
    const from = m ? m[1] : settings.place;
    const to = m ? m[2] : arg;
    return directionsText(from, to, false, settings);
  }
  if (/^\/walk\b/.test(text)) {
    const arg = text.replace(/^\/walk\s*/, "").trim();
    const m = arg.match(/^(.+?)\s+(?:to|->|→)\s+(.+)$/);
    const from = m ? m[1] : settings.place;
    const to = m ? m[2] : arg;
    if (!to) return "Usage: /walk <from> to <to>";
    return directionsText(from, to, true, settings);
  }
  if (/^\/area\b/.test(text)) {
    const q = text.replace(/^\/area\s*/, "").trim();
    if (!q) return "Usage: /area <place> \u2014 what's around there";
    return areaText(q);
  }
  if (text === "/start" || text === "/help") {
    return `\u{1F44B} OpsHub v${VERSION}

Commands:
/report \u2014 daily report (runs, trading, weather, news, reminders, to-dos)
/reminders \xB7 /remind 48 <text> \xB7 /remind 24 every <text> \xB7 /delete <id>
/weather \u2014 now + today/tomorrow where you are
/news \u2014 forex calendar (Forex Factory), times in YOUR time
/headlines \u2014 free news articles (BBC, ForexLive, Al Jazeera, DW, CNN)
/directions <from> to <to> \xB7 /walk <from> to <to> \xB7 /area <place>
/where <place> \u2014 move OpsHub with you (time, weather, alerts shift)
/tz <IANA> \u2014 set timezone \xB7 /time [place] \u2014 what time is it there
/repos \xB7 /status \xB7 /forget <chain>

Or just talk to me: "I'm in Turkey now", "remind me every day at 08:00",
"delete it", "any news before I trade?", "how do I get to Limassol?"`;
  }
  if (text.startsWith("/")) {
    return "Unknown command. Use /start for the list, or just ask me in plain words.";
  }
  return null;
}
function abort2(ms) {
  return AbortSignal.timeout(ms);
}
app.all("/_telegram", async (ctx) => {
  try {
    const update = await ctx.req.json();
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    const db = ctx.env.DB;
    const settings = db ? await getSettings(db) : { ...DEFAULT_SETTINGS };
    const echo = ctx.req.query("echo") === "1";
    let reply = null;
    let chatId = null;
    let needsAI = false;
    let userText = "";
    if (update.message && update.message.text) {
      const text = update.message.text.trim();
      chatId = update.message.chat.id;
      userText = text;
      if (db && text.startsWith("/")) {
        try {
          await ensureTables(db);
        } catch (e) {
        }
        reply = await handleCommand(text, chatId, ctx, settings);
      } else {
        needsAI = true;
      }
    }
    if (update.callback_query) {
      chatId = update.callback_query.message.chat.id;
      const data = update.callback_query.data || "";
      if (data.startsWith("delete:") && db) {
        const id = parseInt(data.substring(7), 10);
        try {
          await ensureTables(db);
          const row = await deleteReminder(db, chatId, id);
          reply = row ? `\u2705 Reminder #${id} cancelled: "${row.text}"` : `No active reminder #${id}.`;
        } catch (e) {
          reply = "Could not delete: " + String(e).slice(0, 120);
        }
      }
    }
    if (needsAI) {
      const work = (async () => {
        const groqKey = ctx.env.GROQ_API_KEY;
        if (!groqKey) return "AI is not configured.";
        try {
          await ensureTables(db);
          await pushChatLog(db, chatId, "user", userText);
          const [statuses, reminders] = await Promise.all([
            repoStatuses(ctx).catch(() => null),
            listReminders(db, chatId).catch(() => [])
          ]);
          const context = await aiContext(db, chatId, settings, statuses, reminders);
          const messages = [
            { role: "system", content: `You are OpsHub, a personal Telegram operations assistant (AI studio fleet + trading + daily planning).

${context}

${aiRules(settings)}` },
            { role: "user", content: userText }
          ];
          const aiReply = await callGroq(groqKey, messages);
          if (!aiReply) return "AI had an issue. Try /start for commands.";
          const out = await runProtocol(aiReply, chatId, ctx, settings);
          const finalText = out.text || aiReply;
          await pushChatLog(db, chatId, "bot", finalText);
          return finalText;
        } catch (e) {
          console.error("Groq AI error:", e);
          return "AI is having issues. Try /start for commands.";
        }
      })();
      if (echo) {
        const text = await work;
        return ctx.json({ status: "ok", reply: text }, 200);
      }
      if (botToken && chatId) {
        try {
          await fetch("https://api.telegram.org/bot" + botToken + "/sendChatAction", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": "OpsHub" },
            body: JSON.stringify({ chat_id: chatId, action: "typing" })
          });
        } catch (e) {
        }
      }
      ctx.executionCtx.waitUntil(
        work.then((t) => botToken && chatId ? sendTelegram(botToken, chatId, t) : null)
      );
      return ctx.json({ status: "ok" }, 200);
    }
    if (reply && chatId && botToken && !echo) {
      await sendTelegram(botToken, chatId, reply);
    }
    return ctx.json({ status: "ok", reply: reply || void 0 }, 200);
  } catch (e) {
    console.error("Telegram webhook error:", e);
    return ctx.json({ status: "ok", error: String(e && e.message || e) }, 200);
  }
});
app.post("/sweep", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    const now = Math.floor(Date.now() / 1e3);
    const due = await ctx.env.DB.prepare(
      "SELECT id, chat_id, text, due_at, repeat_h FROM reminders WHERE active = 1 AND due_at <= ? LIMIT 20"
    ).bind(now).all();
    const rows = due.results || [];
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    let fired = 0;
    for (const r of rows) {
      if (botToken) {
        const ok = await sendTelegram(botToken, r.chat_id, `\u23F0 Reminder #${r.id}: ${r.text}`);
        if (!ok) continue;
      }
      if (r.repeat_h > 0) {
        let next = r.due_at;
        while (next <= now) next += r.repeat_h * 3600;
        await ctx.env.DB.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").bind(next, r.id).run();
      } else {
        await ctx.env.DB.prepare("UPDATE reminders SET active = 0 WHERE id = ?").bind(r.id).run();
      }
      fired++;
    }
    let alerts = 0;
    try {
      alerts = await newsAlerts(ctx);
    } catch (e) {
    }
    let icc = "skipped";
    try {
      const token = ctx.env.HUB_GITHUB_TOKEN;
      if (token) {
        const j = await ghGet("/repos/landryparadis012-git/icc-engine/actions/runs?per_page=3", token);
        const runs = j.workflow_runs || [];
        const active = runs.some((r) => r.status === "queued" || r.status === "in_progress");
        const last = runs[0] ? Date.parse(runs[0].created_at) : 0;
        const staleMin = last ? (Date.now() - last) / 6e4 : 1e9;
        const dispRaw = await kvGet(ctx.env.DB, "icc_dispatch");
        const dispT = dispRaw ? JSON.parse(dispRaw).t || 0 : 0;
        const dispAgeMin = Date.now() / 1e3 / 60 - dispT / 60;
        if (!active && staleMin > 20 && dispAgeMin > 20) {
          const ok = await dispatchGitHub(token, "icc-engine", "icc.run", {
            reason: "sweep self-heal",
            staleMin: Math.round(staleMin)
          });
          if (ok) {
            await kvSet(ctx.env.DB, "icc_dispatch", { t: Math.floor(Date.now() / 1e3) });
            icc = "dispatched";
          } else icc = "dispatch_failed";
        } else icc = active ? "running" : "fresh";
      } else icc = "no_token";
    } catch (e) {
      icc = "error:" + String(e).slice(0, 40);
    }
    return ctx.json({ status: "ok", due: rows.length, fired, alerts, icc });
  } catch (e) {
    console.error("Sweep error:", e);
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});
app.post("/ingest", async (ctx) => {
  try {
    const raw2 = await ctx.req.text();
    let body;
    try {
      body = JSON.parse(raw2);
    } catch (_) {
      return ctx.json({ error: "bad json" }, 400);
    }
    const token = ctx.env.HUB_GITHUB_TOKEN;
    if (body && body.type && !body.repo) {
      const sigOk = await verifySignature(
        raw2,
        ctx.req.header("x-hub-signature-256") || "",
        ctx.env.HUB_WEBHOOK_SECRET
      );
      if (!sigOk) return ctx.json({ error: "invalid signature" }, 401);
      if (!ctx.env.DB) return ctx.json({ status: "ok", event: body.type, stored: false }, 200);
      await ensureTables(ctx.env.DB);
      const r = await storeEvent(ctx.env.DB, body);
      return ctx.json({ status: "ok", event: body.type, ...r }, 200);
    }
    if (!token || !body.repo) {
      return ctx.json({ error: "missing token or repo" }, 400);
    }
    const seriesName = body.client_payload?.series_name || "";
    const episode = body.client_payload?.episode || "";
    const dedupKey = body.repo + ":" + seriesName + ":" + episode;
    if (ctx.env.DB) {
      try {
        await ensureTables(ctx.env.DB);
        const existing = await ctx.env.DB.prepare("SELECT id FROM dispatched WHERE dedup_key = ?").bind(dedupKey).first();
        if (existing) {
          return ctx.json({
            status: "duplicate",
            message: "Episode already dispatched: " + dedupKey
          }, 200);
        }
        await ctx.env.DB.prepare(
          "INSERT INTO dispatched (dedup_key, repo, series, episode, dispatched_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(dedupKey, body.repo, seriesName, episode, (/* @__PURE__ */ new Date()).toISOString()).run();
      } catch (e) {
        console.error("D1 dedup error:", e);
      }
    }
    const success = await dispatchGitHub(token, body.repo, "opshub.produce", body.client_payload);
    return ctx.json({ status: success ? "accepted" : "dispatch_failed", dedup_key: dedupKey }, 200);
  } catch (e) {
    console.error("Ingest error:", e);
    return ctx.json({ error: "internal error" }, 500);
  }
});
app.post("/emit", async (ctx) => {
  try {
    const body = await ctx.req.json();
    if (body && body.type && !body.repo) {
      if (ctx.env.DB) {
        await ensureTables(ctx.env.DB);
        const r = await storeEvent(ctx.env.DB, body);
        return ctx.json({ status: "accepted", ...r }, 200);
      }
      return ctx.json({ status: "accepted", stored: false }, 200);
    }
    const token = ctx.env.HUB_GITHUB_TOKEN;
    if (token && body.repo) {
      await dispatchGitHub(token, body.repo, "legacy.produce", body.client_payload);
    }
    return ctx.json({ status: "accepted" }, 200);
  } catch (e) {
    return ctx.json({ error: "internal error" }, 500);
  }
});
app.get("/repos", async (ctx) => ctx.json({ repos: REPOS }));
app.get("/status", async (ctx) => {
  const settings = ctx.env.DB ? await getSettings(ctx.env.DB) : { ...DEFAULT_SETTINGS };
  const p = localParts(/* @__PURE__ */ new Date(), settings.tz);
  return ctx.json({
    status: "ok",
    version: VERSION,
    mode: "Telegram-first",
    place: settings.place,
    tz: settings.tz,
    local_time: p.hhmm
  });
});
app.get("/report", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.json({ error: "bad secret" }, 403);
  const settings = ctx.env.DB ? await getSettings(ctx.env.DB) : { ...DEFAULT_SETTINGS };
  const text = await buildReport(ctx, ctx.req.query("chat_id") || "0", "daily", settings);
  return ctx.text(text);
});
app.post("/report-tick", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    const ownerRow = await kvGet(ctx.env.DB, "report_owner");
    const owner = ownerRow ? JSON.parse(ownerRow).chat : null;
    if (!owner) return ctx.json({ status: "ok", skipped: "no owner registered" });
    const settings = await getSettings(ctx.env.DB);
    const local = localParts(/* @__PURE__ */ new Date(), settings.tz);
    const force = ctx.req.query("force");
    let mode = null;
    if (local.hour >= 7 && local.hour <= 9) mode = "morning";
    else if (local.hour >= 21) mode = "evening";
    if (!mode && !force) {
      return ctx.json({ status: "ok", skipped: "outside report windows", local: local.hhmm, tz: settings.tz });
    }
    if (!mode) mode = "daily";
    const key = `report:${mode}:${local.date}`;
    if (!force) {
      const done = await kvGet(ctx.env.DB, key);
      if (done) return ctx.json({ status: "ok", skipped: "already sent", local: local.hhmm });
    }
    const text = await buildReport(ctx, owner, mode, settings);
    const sent = await sendTelegram(ctx.env.TELEGRAM_BOT_TOKEN, owner, text);
    if (sent && !force) await kvSet(ctx.env.DB, key, { sentAt: Date.now() });
    return ctx.json({ status: "ok", sent: sent ? mode : "telegram failed", local: local.hhmm });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});
app.post("/set-owner", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    const body = await ctx.req.json();
    if (!body.chat_id) return ctx.json({ error: "chat_id required" }, 400);
    await ensureTables(ctx.env.DB);
    const cur = await kvGet(ctx.env.DB, "report_owner");
    const curChat = cur ? JSON.parse(cur).chat : null;
    const secret = ctx.env.HUB_WEBHOOK_SECRET;
    const authed = !curChat || secret && body.secret === secret || String(body.chat_id) === String(curChat);
    if (!authed) return ctx.json({ error: "owner already set \u2014 pass secret to change" }, 403);
    await kvSet(ctx.env.DB, "report_owner", { chat: String(body.chat_id), setAt: Date.now() });
    return ctx.json({ status: "ok", owner: String(body.chat_id) });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});
function isAdmin(ctx) {
  const secret = ctx.env.HUB_WEBHOOK_SECRET;
  if (!secret) return true;
  return ctx.req.query("secret") === secret;
}
app.get("/reminders", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  if (!isAdmin(ctx)) return ctx.json({ error: "bad secret" }, 403);
  try {
    await ensureTables(ctx.env.DB);
    const chatId = ctx.req.query("chat_id") || "0";
    return ctx.json({ reminders: await listReminders(ctx.env.DB, chatId) });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});
app.get("/settings", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  if (!isAdmin(ctx)) return ctx.json({ error: "bad secret" }, 403);
  const s = await getSettings(ctx.env.DB);
  const p = localParts(/* @__PURE__ */ new Date(), s.tz);
  return ctx.json({ settings: s, local_time: p.hhmm });
});
app.post("/debug-dispatch", async (ctx) => {
  try {
    const body = await ctx.req.json();
    const repo = body.repo || "faceless-studio";
    const token = ctx.env.HUB_GITHUB_TOKEN;
    if (!token) return ctx.json({ error: "HUB_GITHUB_TOKEN not set" }, 500);
    const success = await dispatchGitHub(token, repo, "opshub.produce", body.client_payload);
    return ctx.json({ success });
  } catch (e) {
    return ctx.json({ error: e.message }, 500);
  }
});
app.get("/init-db", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    return ctx.json({ status: "ok" });
  } catch (e) {
    return ctx.json({ error: e.message }, 500);
  }
});
app.post("/debug-ai", async (ctx) => {
  try {
    const body = await ctx.req.json();
    const groqKey = ctx.env.GROQ_API_KEY;
    if (!groqKey) return ctx.json({ error: "GROQ_API_KEY not set" }, 500);
    const reply = await callGroq(groqKey, [
      { role: "system", content: body.system || "You are OpsHub. Reply concisely." },
      { role: "user", content: body.text || "Say hello" }
    ]);
    return ctx.json({ reply });
  } catch (e) {
    return ctx.json({ error: e.message }, 500);
  }
});
var index_default = app;
export {
  index_default as default
};
