import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { DataItem, Route } from '@/types';
import got from '@/utils/got';

// Dot-path resolver matching the upstream `/rsshub/transform/json` route: `a.b.c`
// for nested keys, `a.0.b` for array indices.
function jsonGet(obj: unknown, attr?: string | null): unknown {
    if (!attr || typeof attr !== 'string') {
        return obj;
    }
    let cur: any = obj;
    for (const key of attr.split('.')) {
        if (cur == null) {
            return undefined;
        }
        cur = cur[key];
    }
    return cur;
}

export const route: Route = {
    path: '/json',
    categories: ['other'],
    example: '/scrape/json?url=https%3A%2F%2Fwww.latepost.com%2Fsite%2Findex&method=POST&body=page%3D1%26limit%3D20&item=data&itemTitle=title&itemLink=detail_url&itemDesc=abstract&itemPubDate=release_time',
    parameters: {
        url: 'Target URL (required, URL-encoded).',
        title: 'Feed title. Defaults to the request hostname.',
        method: 'HTTP method: `GET` (default) or `POST`.',
        body: 'Request body for POST. Form-urlencoded string (default) or raw JSON (see `contentType`).',
        contentType: '`form` (default) or `json` — determines how `body` is sent.',
        headers: 'Optional JSON object of additional request headers, URL-encoded.',
        item: 'Dot-path to the items array inside the JSON response. Example: `data`.',
        itemTitle: 'Dot-path to the title within each item.',
        itemLink: 'Dot-path to the link within each item.',
        linkPrefix: 'Prefix prepended to relative item links. Defaults to the URL origin.',
        itemDesc: 'Dot-path to the description within each item.',
        itemPubDate: 'Dot-path to the pubDate within each item.',
        itemGuid: 'Dot-path to a stable item ID. Defaults to the link.',
        limit: 'Max number of items to emit (default 30).',
    },
    features: {
        requireConfig: [
            {
                name: 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN',
                description: 'Must be `true` to allow user-supplied target URLs.',
            },
        ],
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: 'Generic JSON to RSS (query params, POST-capable)',
    maintainers: ['Shengqiang-Zhang'],
    description: `A JSON-endpoint equivalent of \`/scrape/html\`. Reads every option from the query string so it survives proxies that normalise \`%2F\` in paths (e.g. Azure App Service), and supports \`POST\` with a form or JSON body — for sites whose article list API does not accept \`GET\`.

Dot-path selectors match the upstream \`/rsshub/transform/json\` route: \`a.b.c\` for nested keys, \`a.0.b\` for array indices.`,
    handler: async (ctx) => {
        if (!config.feature.allow_user_supply_unsafe_domain) {
            throw new ConfigNotFoundError(`This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.`);
        }

        const params = ctx.req.query();
        const url = params.url;
        if (!url) {
            throw new Error('Query parameter `url` is required.');
        }

        const method = (params.method || 'GET').toUpperCase();
        const contentType = (params.contentType || 'form').toLowerCase();

        const extraHeaders: Record<string, string> = {};
        if (params.headers) {
            try {
                Object.assign(extraHeaders, JSON.parse(params.headers));
            } catch {
                throw new Error('Query parameter `headers` must be a valid JSON object.');
            }
        }
        // Many Chinese-site XHR endpoints 404 / redirect without this header.
        if (method === 'POST' && !Object.keys(extraHeaders).some((h) => h.toLowerCase() === 'x-requested-with')) {
            extraHeaders['X-Requested-With'] = 'XMLHttpRequest';
        }

        const gotOpts: Record<string, unknown> = {
            method: method.toLowerCase(),
            url,
            headers: extraHeaders,
            responseType: 'json',
        };

        if (method === 'POST' && params.body) {
            if (contentType === 'json') {
                try {
                    gotOpts.json = JSON.parse(params.body);
                } catch {
                    throw new Error('Query parameter `body` must be valid JSON when contentType=json.');
                }
            } else {
                const form: Record<string, string> = {};
                for (const [k, v] of new URLSearchParams(params.body)) {
                    form[k] = v;
                }
                gotOpts.form = form;
            }
        }

        const response = await got(gotOpts);
        const data = response.data;

        const rssTitle = params.title || new URL(url).hostname;

        const itemsRaw = params.item ? jsonGet(data, params.item) : data;
        if (!Array.isArray(itemsRaw)) {
            throw new Error(`Path \`${params.item || '(root)'}\` did not resolve to an array.`);
        }

        const linkPrefix = params.linkPrefix ?? new URL(url).origin;
        const limit = Math.min(Math.max(Number.parseInt(params.limit || '30', 10) || 30, 1), 100);

        const items: DataItem[] = itemsRaw.slice(0, limit).map((item) => {
            let link: string | undefined;
            if (params.itemLink) {
                const raw = jsonGet(item, params.itemLink);
                if (raw != null) {
                    link = String(raw).trim();
                    if (link && !link.startsWith('http') && linkPrefix) {
                        link = `${linkPrefix}${link.startsWith('/') ? '' : '/'}${link}`;
                    }
                }
            }

            const titleVal = params.itemTitle ? jsonGet(item, params.itemTitle) : undefined;
            const descVal = params.itemDesc ? jsonGet(item, params.itemDesc) : undefined;
            const pubVal = params.itemPubDate ? jsonGet(item, params.itemPubDate) : undefined;
            const guidVal = params.itemGuid ? jsonGet(item, params.itemGuid) : undefined;

            return {
                title: titleVal != null ? String(titleVal) : '',
                link,
                description: descVal != null ? String(descVal) : undefined,
                pubDate: pubVal != null ? String(pubVal) : undefined,
                guid: guidVal != null ? String(guidVal) : link,
            } as DataItem;
        });

        return {
            title: rssTitle,
            link: url,
            description: `Proxy ${url}`,
            item: items,
        };
    },
};
