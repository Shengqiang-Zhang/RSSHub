import { load } from 'cheerio';
import sanitizeHtml from 'sanitize-html';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';

export const route: Route = {
    path: '/html',
    categories: ['other'],
    example: '/scrape/html?url=https%3A%2F%2Fwww.anthropic.com%2Fengineering&item=a%5Bhref%5E%3D%22%2Fengineering%2F%22%5D%3Ahas(h3)&itemTitle=h3&itemDesc=p',
    parameters: {
        url: 'Target page URL (query parameter, URL-encoded)',
        title: 'Feed title. Defaults to the page `<title>`.',
        item: 'CSS selector for each item container. Defaults to `html`.',
        itemTitle: 'CSS selector for the title element inside `item`. Defaults to the item itself.',
        itemTitleAttr: 'Attribute to read for the title (defaults to element text).',
        itemLink: 'CSS selector for the link element inside `item`. Defaults to the item itself.',
        itemLinkAttr: 'Attribute to read for the link (defaults to `href`).',
        itemDesc: 'CSS selector for the description element.',
        itemDescAttr: 'Attribute to read for the description (defaults to inner HTML).',
        itemPubDate: 'CSS selector for the pubDate element.',
        itemPubDateAttr: 'Attribute to read for pubDate (defaults to inner HTML).',
        itemContent: 'CSS selector for full content. When set, the route fetches each item link and extracts this selector.',
        encoding: 'Response encoding (default `utf-8`).',
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
    name: 'Generic HTML to RSS (query params)',
    maintainers: ['Shengqiang-Zhang'],
    description: `A variant of \`/rsshub/transform/html\` that reads every option from the query string instead of path segments.

Use this when your RSSHub sits behind a proxy or PaaS frontend that normalises \`%2F\` in URL paths (such as Azure App Service), which breaks the upstream transform route's \`:url/:routeParams\` pattern.

All upstream parameters are supported with the same semantics.`,
    handler: async (ctx) => {
        if (!config.feature.allow_user_supply_unsafe_domain) {
            throw new ConfigNotFoundError(`This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.`);
        }

        const url = ctx.req.query('url');
        if (!url) {
            throw new Error('Query parameter `url` is required.');
        }

        const response = await got({
            method: 'get',
            url,
            responseType: 'arrayBuffer',
        });

        const params = ctx.req.query();
        const encoding = params.encoding || 'utf-8';
        const decoder = new TextDecoder(encoding);

        const $ = load(decoder.decode(response.data));
        const rssTitle = params.title || $('title').text();
        const itemSelector = params.item || 'html';

        let items: DataItem[] = $(itemSelector)
            .toArray()
            .slice(0, 20)
            .map((el) => {
                try {
                    const $el = $(el);

                    const titleEle = params.itemTitle ? $el.find(params.itemTitle) : $el;
                    const title = params.itemTitleAttr ? titleEle.attr(params.itemTitleAttr) : titleEle.text();

                    let link: string | undefined;
                    const linkEle = params.itemLink ? $el.find(params.itemLink) : $el;
                    if (params.itemLinkAttr) {
                        link = linkEle.attr(params.itemLinkAttr);
                    } else {
                        link = linkEle.is('a') ? linkEle.attr('href') : linkEle.find('a').attr('href');
                    }
                    if (link) {
                        link = link.trim();
                        if (!link.startsWith('http')) {
                            link = new URL(link, url).href;
                        }
                    }

                    const descEle = params.itemDesc ? $el.find(params.itemDesc) : $el;
                    const desc = params.itemDescAttr ? descEle.attr(params.itemDescAttr) : descEle.html();

                    const pubDateEle = params.itemPubDate ? $el.find(params.itemPubDate) : $el;
                    const pubDate = params.itemPubDateAttr ? pubDateEle.attr(params.itemPubDateAttr) : pubDateEle.html();

                    return {
                        title: title || '',
                        link,
                        description: desc || undefined,
                        pubDate,
                    } as DataItem;
                } catch {
                    return null;
                }
            })
            .filter((i): i is DataItem => !!i);

        const itemContentSelector = params.itemContent;
        if (itemContentSelector) {
            items = await Promise.all(
                items.map((entry) => {
                    if (!entry.link) {
                        return entry;
                    }
                    return cache.tryGet(`scrape:${entry.link}:${itemContentSelector}`, async () => {
                        const r = await got({
                            method: 'get',
                            url: entry.link,
                            responseType: 'arrayBuffer',
                        });
                        if (!r || typeof r === 'string') {
                            return entry;
                        }
                        const $inner = load(decoder.decode(r.data));
                        const content = $inner(itemContentSelector).html();
                        if (!content) {
                            return entry;
                        }
                        entry.description = sanitizeHtml(content, {
                            allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
                        });
                        return entry;
                    }) as Promise<DataItem>;
                })
            );
        }

        return {
            title: rssTitle,
            link: url,
            description: `Proxy ${url}`,
            item: items,
        };
    },
};
