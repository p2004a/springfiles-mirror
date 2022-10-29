import * as gcpPubSub from './gcpPubSub';
import * as lib from '../../lib';

export interface Env {
    ASSETS_KV: KVNamespace;
    R2_BUCKET: R2Bucket;
    PUBSUB_TOPIC: string;
    SERVICE_ACCOUNT_KEY: string;
    ALLOWED_CATEGORIES: string;
}

async function handleFind(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
    const allowedCategories = new Set(env.ALLOWED_CATEGORIES.split(','));
    for (const [key, value] of url.searchParams) {
        if (key != 'category' && key != 'springname') {
            console.info(`Unknown param: '${key}' = '${value}', ignoring`)
        }
    }

    if (!url.searchParams.has('category')) {
        throw lib.httpBadRequest('Missing category param');
    }
    if (!url.searchParams.has('springname')) {
        throw lib.httpBadRequest('Missing springname param');
    }
    const category = url.searchParams.get('category')!;
    const springname = url.searchParams.get('springname')!;

    const upstreamUrl = new URL('https://springfiles.springrts.com/json.php');
    upstreamUrl.searchParams.set('category', category);
    upstreamUrl.searchParams.set('springname', springname);
    if (!allowedCategories.has(category)) {
        return Response.redirect(upstreamUrl.toString(), 302);
    }
    if (springname.length > 100) {
        throw lib.httpBadRequest('springname too long');
    }

    const value = await env.ASSETS_KV.get(lib.getKVKey(category, springname));
    let asset: lib.SpringFilesAsset;
    if (value !== null) {
        asset = JSON.parse(value);
        asset.mirrors = asset.mirrors.map(p => `${url.origin}/${p}`);
    } else {
        asset = await lib.fetchFromSpringFiles(category, springname);
        ctx.waitUntil((async () => {
            const message: lib.SyncRequest = {
                category: category,
                springname: springname,
            };
            const msgId = await gcpPubSub.publish(
                env.SERVICE_ACCOUNT_KEY,
                env.PUBSUB_TOPIC,
                JSON.stringify(message));
            console.info(`Published message ${msgId} for '${springname}'`);
        })());
    }
    return new Response(JSON.stringify([asset]), {status: 200});
}

async function handleFile(url: URL, env: Env): Promise<Response> {
    const parts = url.pathname.split('/');
    // request must look like /file/{md5hash}/{filename}
    if (parts.length != 4) {
        throw lib.httpBadRequest('Incorrect request for file');
    }
    const object = await env.R2_BUCKET.get(parts[2]);
    if (!object || !object.body) {
        return new Response('Object Not Found', {status: 404});
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    return new Response(object.body, {headers});
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method != 'GET') {
            return new Response('Method Not Allowed', {
                status: 405,
                headers: {Allow: 'GET'},
            });
        }
        try {
            const url = new URL(request.url);
            if (url.pathname === '/find') {
                return await handleFind(url, env, ctx);
            } else if (url.pathname.startsWith('/file/')) {
                return await handleFile(url, env);
            } else {
                throw lib.httpNotFound();
            }
        } catch (e) {
            if (e instanceof lib.HTTPError) {
                return new Response(e.message, {status: e.status});
            }
            throw e;
        }
    },
};