import * as child_process from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as lib from '../../lib/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as stream from 'node:stream'
import { pipeline } from 'node:stream/promises';
import * as util from 'node:util';
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Storage as GCS } from "@google-cloud/storage";

const execFile = util.promisify(child_process.execFile);

class HTTPResponse {
    body: string
    statusCode: number

    constructor(body: string, statusCode: number = 200) {
        this.body = body;
        this.statusCode = statusCode;
    }

    writeResponse(res: http.ServerResponse) {
        res.statusCode = this.statusCode;
        res.write(this.body);
        res.end();
    }
}

interface PubSubRequest {
    message: PubSubMessage,
    subscription: string,
}

interface PubSubMessage {
    attributes?: {[key: string]: string},
    data?: string,
    messageId: string,
    publishTime: string,
}

async function uploadToR2(filename: string, body: ReadableStream<Uint8Array>) {
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${process.env.CF_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.CF_R2_ACCESS_KEY_ID!,
            secretAccessKey: process.env.CF_R2_ACCESS_KEY_SECRET!,
        }
    });
    // Would be nice if we had some e2e integrity checks here, but i've not
    // figured out how to do it well currectly with this API when it's a
    // multi part upload.
    const upload = new Upload({
        client,
        params: {
            Bucket: process.env.CF_R2_BUCKET!,
            Key: filename,
            Body: body
        }
    });
    await upload.done();
}

async function cfKVPut(key: string, value: string) {
    const url = `https://api.cloudflare.com/client/v4/accounts`
        + `/${process.env.CF_ACCOUNT_ID!}/storage/kv/namespaces`
        + `/${process.env.CF_KV_NAMESPACE_ID!}/values/${encodeURIComponent(key)}`;
    const response = await fetch(url, {
        method: 'PUT',
        headers: {'Authorization': `Bearer ${process.env.CF_KV_API_TOKEN!}`},
        body: value,
    });
    try {
        if (!response.ok) {
            console.error(await response.json());
            throw lib.httpInternalServerError("Cloudflare set key failed");
        }
    } finally {
        await response.body?.cancel();
    }
}

async function saveToCDN(asset: lib.SpringFilesAsset, file: ReadableStream<Uint8Array>) {
    // Let's filter down properties only to the ones we need.
    const baseAsset: lib.SpringFilesAsset = {
            filename: asset.filename,
            springname: asset.springname,
            md5: asset.md5,
            category: asset.category,
            path: asset.path,
            tags: [],
            size: asset.size,
            timestamp: asset.timestamp,
            mirrors: [`file/${asset.md5}/${asset.filename}`],
    };
    await uploadToR2(asset.md5, file);
    await cfKVPut(lib.getKVKey(asset.category, asset.springname), JSON.stringify(baseAsset));
    console.log(`Upload of ${asset.springname} done`);
    console.log(JSON.stringify(baseAsset));
}

async function handleSyncRequest(req: lib.SyncRequest) {
    console.info(`fetching ${req.category}/${req.springname}`);
    const asset = await lib.fetchFromSpringFiles(req.category, req.springname);

    // Upload file to R2
    const response = await fetch(asset.mirrors[0]);
    try {
        if (!response.ok) {
            throw lib.httpBadGateway(`Fetch from springfiles failed with ${response.status}`);
        }
        await saveToCDN(asset, response.body!);
    } finally {
        await response.body?.cancel();
    }
}

// https://cloud.google.com/storage/docs/json_api/v1/objects#resource-representations
// Minimal set of properties we need
interface GCSObjectResource {
    bucket: string,
    name: string,
}

async function fileMd5(path: string): Promise<string> {
    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(path);
        const readS = handle.createReadStream();
        const md5 = crypto.createHash('md5');
        await pipeline([readS, md5]);
        return md5.digest('hex').toLowerCase();
    } finally {
        await handle?.close();
    }
}

// Based on implementation in upq.
function getNormalizedFileName(springname: string, mapPath: string): string {
    const ext = path.extname(mapPath);
    const name = springname.toLowerCase().replaceAll(/[^abcdefghijklmnopqrstuvwxyz_.01234567890-]/g, "_");
    return `${name}${ext}`.substring(0, 255);
}

async function getSpringName(mapPath: string): Promise<string> {
    const { stdout } = await execFile(process.env.PYSMF_PATH!, [mapPath], {timeout: 60*1000});
    return JSON.parse(stdout)['springname'];
}

async function handleUploadRequest(obj: GCSObjectResource) {
    console.log(`Event: ${obj.name} got uploaded to ${obj.bucket} bucket`);
    const storage = new GCS();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-'));
    const mapPath = path.join(tmpDir, obj.name);
    let handle: fs.FileHandle | undefined
    try {
        await storage.bucket(obj.bucket).file(obj.name).download({destination: mapPath}); 
        const springname = await getSpringName(mapPath);
        const asset: lib.SpringFilesAsset = {
            springname,
            category: "map",
            path: "maps",
            tags: [],
            filename: getNormalizedFileName(springname, mapPath),
            md5: await fileMd5(mapPath),
            size: (await fs.stat(mapPath)).size,
            timestamp: new Date().toISOString().replace('Z', ''),
            mirrors: [],
        };
        handle = await fs.open(mapPath);
        const readStream = stream.Readable.toWeb(handle.createReadStream());
        await saveToCDN(asset, readStream);
    } finally {
        await handle?.close();
        await fs.rm(tmpDir, {recursive: true});
    }
}

async function handlePubSub(buffer: Buffer, url: URL): Promise<HTTPResponse> {
    const msg: PubSubRequest = JSON.parse(buffer.toString('utf8'));
    if (!msg.message.data) {
        throw lib.httpBadRequest('message doesn\'t have data property');
    }
    const dataBuf = Buffer.from(msg.message.data, 'base64');
    const parsedData = JSON.parse(dataBuf.toString('utf8'));

    switch (url.pathname) {
        case "/cache":
            await handleSyncRequest(parsedData);
            if (!msg.message.attributes ||
                msg.message.attributes["requestType"] != "SyncRequest") {
                throw lib.httpBadRequest("expected requestType=SyncRequest attribute");
            }
            break;
        case "/upload":
            if (!msg.message.attributes ||
                msg.message.attributes["eventType"] != "OBJECT_FINALIZE" ||
                msg.message.attributes["payloadFormat"] != "JSON_API_V1") {
                throw lib.httpBadRequest("expected OBJECT_FINALIZE with JSON_API_V1 payload");
            }
            await handleUploadRequest(parsedData);
            break;
        default:
            throw lib.httpNotFound("not defined handling for requested endpoint");
    }
    return new HTTPResponse("ok", 200);
}

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Array<Buffer> = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
        if (!req.complete) {
            console.error('The connection was terminated before getting all data');
        } else {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const data = Buffer.concat(chunks);
            handlePubSub(data, url).then(response => {
                response.writeResponse(res);
            }).catch(e => {
                if (!(e instanceof lib.HTTPError)) {
                    console.error(e);
                    e = lib.httpInternalServerError();
                }
                const response = new HTTPResponse(e.message, e.status);
                response.writeResponse(res);
            });
        }
    });
    req.on('error', (err: Error) => {
        console.error(err);
    });
}

function main() {
    for (const env of ['CF_ACCOUNT_ID',
                       'CF_R2_BUCKET',
                       'CF_R2_ACCESS_KEY_ID',
                       'CF_R2_ACCESS_KEY_SECRET',
                       'CF_KV_NAMESPACE_ID',
                       'CF_KV_API_TOKEN',
                       'PYSMF_PATH']) {
        if (!process.env[env]) {
            throw new Error(`Required environment variable ${env} not set`);
        }
    }

    let port = 8080;
    if (process.env.PORT) {
        port = parseInt(process.env.PORT);
    } else {
        console.log(`No PORT env varaible set, listening on default ${port}`);
    }
    http.createServer(handler)
        .listen(process.env.PORT ? parseInt(process.env.PORT) : 8080);
}

main();
