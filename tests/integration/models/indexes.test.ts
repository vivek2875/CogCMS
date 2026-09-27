import { describe, expect, it } from 'vitest';
import { ensureIndexes } from '@/scripts/ensure-indexes';
import { modelRegistry } from '@/scripts/model-registry';
import Author from '@/models/Author';
import ApiKey from '@/models/ApiKey';
import Blog from '@/models/Blog';
import BlogRevision from '@/models/BlogRevision';
import NewsletterSubscriber from '@/models/NewsletterSubscriber';
import ReleaseNote from '@/models/ReleaseNote';
import Whitepaper from '@/models/Whitepaper';
import { createTestSite } from '@/tests/setup/factories';

function snapshot() {
  return {
    html: '<p>Hello</p>',
    toc: [],
    wordCount: 1,
    readingTime: 1,
    pipelineVersion: 1,
    renderedAt: new Date(),
  };
}

describe('model registry and indexes', () => {
  it('uses the final collection names and creates every declared index', async () => {
    await ensureIndexes();
    expect(modelRegistry.map((model) => model.collection.collectionName)).toEqual([
      'sites',
      'users',
      'login_attempts',
      'blogs',
      'blog_revisions',
      'authors',
      'faqs',
      'faq_submissions',
      'whitepapers',
      'newsletter_subscribers',
      'release_notes',
      'api_keys',
      'intake_rate_limits',
    ]);

    const blogIndexes = await Blog.collection.indexes();
    expect(blogIndexes.map((index) => index.key)).toEqual(
      expect.arrayContaining([
        { _id: 1 },
        { siteId: 1 },
        { siteId: 1, slug: 1 },
        { siteId: 1, status: 1, createdAt: -1 },
      ]),
    );
    expect(
      blogIndexes.find((index) => index.key.siteId === 1 && index.key.slug === 1)?.unique,
    ).toBe(true);

    const revisionIndexes = await BlogRevision.collection.indexes();
    expect(revisionIndexes.map((index) => index.key)).toEqual(
      expect.arrayContaining([{ _id: 1 }, { siteId: 1, blogId: 1, createdAt: -1, _id: -1 }]),
    );

    const releaseNoteIndexes = await ReleaseNote.collection.indexes();
    expect(releaseNoteIndexes.map((index) => index.key)).toEqual(
      expect.arrayContaining([
        { _id: 1 },
        { siteId: 1 },
        { siteId: 1, slug: 1 },
        { siteId: 1, releaseDate: -1 },
      ]),
    );

    const apiKeyIndexes = await ApiKey.collection.indexes();
    expect(apiKeyIndexes.map((index) => index.key)).toEqual(
      expect.arrayContaining([
        { _id: 1 },
        { siteId: 1 },
        { prefix: 1 },
        { siteId: 1, createdAt: -1 },
      ]),
    );
    expect(apiKeyIndexes.find((index) => index.key.prefix === 1)?.unique).toBe(true);
  });

  it('permits tenant-local values across sites and rejects them within one site', async () => {
    await ensureIndexes();
    const [siteA, siteB] = await Promise.all([createTestSite(), createTestSite()]);
    const baseBlog = {
      title: 'Shared post',
      slug: 'shared',
      content: '<p>Hello</p>',
      rendered: snapshot(),
      status: 'publish' as const,
    };
    await Blog.create({ ...baseBlog, siteId: siteA._id });
    await expect(Blog.create({ ...baseBlog, siteId: siteB._id })).resolves.toBeDefined();
    await expect(Blog.create({ ...baseBlog, siteId: siteA._id })).rejects.toMatchObject({
      code: 11000,
    });

    await Author.create({ siteId: siteA._id, name: 'Shared author', slug: 'shared-author' });
    await expect(
      Author.create({ siteId: siteB._id, name: 'Shared author', slug: 'shared-author' }),
    ).resolves.toBeDefined();

    const paper = { title: 'Shared paper', slug: 'shared-paper', content: 'Body' };
    await Whitepaper.create({ ...paper, siteId: siteA._id });
    await expect(Whitepaper.create({ ...paper, siteId: siteB._id })).resolves.toBeDefined();
    await expect(Whitepaper.create({ ...paper, siteId: siteA._id })).rejects.toMatchObject({
      code: 11000,
    });

    const subscribedAt = new Date();
    await NewsletterSubscriber.create({
      siteId: siteA._id,
      email: 'reader@example.com',
      firstSubscribedAt: subscribedAt,
      lastSubscribedAt: subscribedAt,
    });
    await expect(
      NewsletterSubscriber.create({
        siteId: siteB._id,
        email: 'reader@example.com',
        firstSubscribedAt: subscribedAt,
        lastSubscribedAt: subscribedAt,
      }),
    ).resolves.toBeDefined();
    await expect(
      NewsletterSubscriber.create({
        siteId: siteA._id,
        email: 'reader@example.com',
        firstSubscribedAt: subscribedAt,
        lastSubscribedAt: subscribedAt,
      }),
    ).rejects.toMatchObject({ code: 11000 });

    await expect(
      NewsletterSubscriber.create({
        siteId: siteA._id,
        email: 'not-an-email',
        firstSubscribedAt: subscribedAt,
        lastSubscribedAt: subscribedAt,
      }),
    ).rejects.toThrow(/email must be valid/);
  });

  it('fails with actionable duplicate keys before attempting index creation', async () => {
    await ensureIndexes();
    const siteId = (await createTestSite())._id;
    await Blog.collection.dropIndex('siteId_1_slug_1');
    await Blog.collection.insertMany([
      { siteId, title: 'One', slug: 'blocked', content: 'Body' },
      { siteId, title: 'Two', slug: 'blocked', content: 'Body' },
    ]);
    try {
      await expect(ensureIndexes()).rejects.toThrow(/blogs[\s\S]*blocked[\s\S]*\(2\)/);
    } finally {
      await Blog.deleteMany({ siteId });
      await Blog.createIndexes();
    }
  });
});
