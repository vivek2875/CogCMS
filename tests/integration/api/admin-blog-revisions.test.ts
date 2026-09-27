import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createBlog } from '@/app/api/admin/blogs/route';
import { DELETE as deleteBlog, PUT as updateBlog } from '@/app/api/admin/blogs/[slug]/route';
import { GET as listRevisions } from '@/app/api/admin/blogs/[slug]/revisions/route';
import { GET as getRevision } from '@/app/api/admin/blogs/[slug]/revisions/[revisionId]/route';
import { POST as restoreRevision } from '@/app/api/admin/blogs/[slug]/revisions/[revisionId]/restore/route';
import { renderBlogSnapshot } from '@/lib/render/blog';
import Blog from '@/models/Blog';
import BlogRevision from '@/models/BlogRevision';
import Author from '@/models/Author';
import { authenticatedRequest, createTestSite, createTestUser } from '@/tests/setup/factories';

const rootContext = { params: Promise.resolve({}) };
const slugContext = (slug: string) => ({ params: Promise.resolve({ slug }) });
const revisionContext = (slug: string, revisionId: string) => ({
  params: Promise.resolve({ slug, revisionId }),
});

async function createRevisionedBlog(status: 'draft' | 'publish' = 'draft', slug = 'history-post') {
  const admin = await createTestUser();
  const site = await createTestSite();
  const response = await createBlog(
    await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
      user: admin,
      siteId: site._id.toString(),
      method: 'POST',
      json: {
        title: 'First title',
        slug,
        excerpt: 'First excerpt',
        content: '<h2>First heading</h2><p>First body</p>',
        tags: ['Engineering'],
        status,
      },
    }),
    rootContext,
  );
  expect(response.status).toBe(201);
  return { admin, site, blog: await response.json() };
}

function revisionSnapshot(title: string, content = `<p>${title}</p>`) {
  return {
    title,
    excerpt: `${title} excerpt`,
    content,
    imageUrl: '',
    tag: 'Insights',
    authorId: null,
    category: '',
    tags: [],
    faqs: [],
    keyTakeaways: [],
    relatedSlugs: [],
    tocOverrides: [],
    metaTitle: '',
    metaDescription: '',
    keywords: '',
    isFeatured: false,
  };
}

describe('site-scoped blog version history', () => {
  it('creates immutable editorial snapshots, updates them, and omits snapshots from history lists', async () => {
    const { admin, site, blog } = await createRevisionedBlog();
    const initial = await BlogRevision.findOne({ siteId: site._id, blogId: blog._id })
      .lean()
      .exec();
    expect(initial?.action).toBe('created');
    expect(initial?.snapshot).toMatchObject({
      title: 'First title',
      excerpt: 'First excerpt',
      content: '<h2>First heading</h2><p>First body</p>',
      tags: ['Engineering'],
    });
    expect(initial?.snapshot).not.toHaveProperty('siteId');
    expect(initial?.snapshot).not.toHaveProperty('rendered');
    expect(initial?.snapshot).not.toHaveProperty('createdBy');

    const update = await updateBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/history-post', {
        user: admin,
        siteId: site._id.toString(),
        method: 'PUT',
        json: { title: 'Second title', content: '<p>Second body</p>' },
      }),
      slugContext('history-post'),
    );
    expect(update.status).toBe(200);
    expect(await BlogRevision.countDocuments({ siteId: site._id, blogId: blog._id })).toBe(2);

    const list = await listRevisions(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/history-post/revisions', {
        user: admin,
        siteId: site._id.toString(),
      }),
      slugContext('history-post'),
    );
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.data).toHaveLength(2);
    expect(listed.meta).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(listed.data[0].createdAt >= listed.data[1].createdAt).toBe(true);
    expect(listed.data[0]).not.toHaveProperty('snapshot');

    const detail = await getRevision(
      await authenticatedRequest(
        `http://localhost:3003/api/admin/blogs/history-post/revisions/${initial?._id}`,
        {
          user: admin,
          siteId: site._id.toString(),
        },
      ),
      revisionContext('history-post', initial!._id.toString()),
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).snapshot.title).toBe('First title');
  });

  it('creates a baseline before the first update to a legacy blog and creates none for invalid input', async () => {
    const admin = await createTestUser();
    const site = await createTestSite();
    const content = '<p>Legacy source</p>';
    const legacy = await Blog.create({
      siteId: site._id,
      title: 'Legacy',
      slug: 'legacy',
      content,
      rendered: await renderBlogSnapshot(content),
      authorId: null,
      status: 'draft',
      createdBy: null,
      updatedBy: null,
    });
    const updated = await updateBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/legacy', {
        user: admin,
        siteId: site._id.toString(),
        method: 'PUT',
        json: { title: 'Modernized' },
      }),
      slugContext('legacy'),
    );
    expect(updated.status).toBe(200);
    const history = await BlogRevision.find({ blogId: legacy._id, siteId: site._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ action: 'created', snapshot: { title: 'Legacy' } });
    expect(history[1]).toMatchObject({ action: 'updated', snapshot: { title: 'Modernized' } });

    const beforeInvalid = await BlogRevision.countDocuments();
    const invalid = await updateBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/legacy', {
        user: admin,
        siteId: site._id.toString(),
        method: 'PUT',
        json: { authorId: 'not-an-object-id' },
      }),
      slugContext('legacy'),
    );
    expect(invalid.status).toBe(400);
    expect(await BlogRevision.countDocuments()).toBe(beforeInvalid);
  });

  it('restores sanitized content while preserving current slug and publication state', async () => {
    const { admin, site, blog } = await createRevisionedBlog('publish');
    const publishedAt = blog.publishedAt;
    const malicious = await BlogRevision.create({
      siteId: site._id,
      blogId: blog._id,
      action: 'updated',
      createdBy: admin._id,
      restoredFromRevisionId: null,
      snapshot: {
        title: 'Recovered title',
        excerpt: 'Recovered excerpt',
        content: '<script>evil()</script><h2>Recovered</h2><p>Safe body</p>',
        imageUrl: '',
        tag: 'Insights',
        authorId: null,
        category: '',
        tags: [],
        faqs: [],
        keyTakeaways: [],
        relatedSlugs: [],
        tocOverrides: [],
        metaTitle: '',
        metaDescription: '',
        keywords: '',
        isFeatured: false,
      },
    });
    const beforeRestore = await BlogRevision.countDocuments({ siteId: site._id, blogId: blog._id });
    const response = await restoreRevision(
      await authenticatedRequest(
        `http://localhost:3003/api/admin/blogs/history-post/revisions/${malicious._id}/restore`,
        { user: admin, siteId: site._id.toString(), method: 'POST', json: {} },
      ),
      revisionContext('history-post', malicious._id.toString()),
    );
    expect(response.status).toBe(200);
    const restored = await response.json();
    expect(restored).toMatchObject({
      title: 'Recovered title',
      slug: 'history-post',
      status: 'publish',
      publishedAt,
    });
    expect(restored.content).not.toContain('evil');
    expect(restored.rendered.html).toContain('Recovered');
    expect(restored.updatedBy).toBe(admin._id.toString());
    const restoreRevisionDocument = await BlogRevision.findOne({
      siteId: site._id,
      blogId: blog._id,
      action: 'restored',
    }).lean();
    expect(restoreRevisionDocument?.restoredFromRevisionId?.toString()).toBe(
      malicious._id.toString(),
    );
    expect(await BlogRevision.countDocuments({ siteId: site._id, blogId: blog._id })).toBe(
      beforeRestore + 1,
    );
  });

  it('does not leak revisions across sites and rejects invalid IDs, unauthenticated users, and inaccessible sites', async () => {
    const { admin, site: siteA } = await createRevisionedBlog();
    const siteB = await createTestSite();
    const foreign = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user: admin,
        siteId: siteB._id.toString(),
        method: 'POST',
        json: { title: 'Foreign', slug: 'foreign', content: '<p>Foreign</p>' },
      }),
      rootContext,
    );
    const foreignBlog = await foreign.json();
    const foreignRevision = await BlogRevision.findOne({
      blogId: foreignBlog._id,
      siteId: siteB._id,
    }).lean();

    const crossList = await listRevisions(
      await authenticatedRequest(
        'http://localhost:3003/api/admin/blogs/foreign/revisions?siteId=' + siteB._id,
        {
          user: admin,
          siteId: siteA._id.toString(),
        },
      ),
      slugContext('foreign'),
    );
    expect(crossList.status).toBe(404);
    const crossDetail = await getRevision(
      await authenticatedRequest(
        `http://localhost:3003/api/admin/blogs/foreign/revisions/${foreignRevision?._id}`,
        {
          user: admin,
          siteId: siteA._id.toString(),
        },
      ),
      revisionContext('foreign', foreignRevision!._id.toString()),
    );
    expect(crossDetail.status).toBe(404);
    const crossRestore = await restoreRevision(
      await authenticatedRequest(
        `http://localhost:3003/api/admin/blogs/foreign/revisions/${foreignRevision?._id}/restore`,
        {
          user: admin,
          siteId: siteA._id.toString(),
          method: 'POST',
          json: {},
        },
      ),
      revisionContext('foreign', foreignRevision!._id.toString()),
    );
    expect(crossRestore.status).toBe(404);

    const invalid = await getRevision(
      await authenticatedRequest(
        'http://localhost:3003/api/admin/blogs/history-post/revisions/not-an-id',
        {
          user: admin,
          siteId: siteA._id.toString(),
        },
      ),
      revisionContext('history-post', 'not-an-id'),
    );
    expect(invalid.status).toBe(400);
    const unauthenticated = await listRevisions(
      new NextRequest('http://localhost:3003/api/admin/blogs/history-post/revisions'),
      slugContext('history-post'),
    );
    expect(unauthenticated.status).toBe(401);

    const editor = await createTestUser({ role: 'editor', siteIds: [siteA._id.toString()] });
    const noAccess = await listRevisions(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/foreign/revisions', {
        user: editor,
        siteId: siteB._id.toString(),
      }),
      slugContext('foreign'),
    );
    expect(noAccess.status).toBe(403);
  });

  it('paginates revision metadata safely and keeps totals isolated to the active site', async () => {
    const { admin, site, blog } = await createRevisionedBlog();
    const extraRevisions = Array.from({ length: 24 }, (_, index) => ({
      siteId: site._id,
      blogId: blog._id,
      action: 'updated' as const,
      createdBy: admin._id,
      restoredFromRevisionId: null,
      snapshot: revisionSnapshot(`Revision ${index + 1}`),
      createdAt: new Date(Date.now() + index + 1),
    }));
    await BlogRevision.insertMany(extraRevisions);

    const otherSite = await createTestSite();
    const otherBlog = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user: admin,
        siteId: otherSite._id.toString(),
        method: 'POST',
        json: { title: 'Other site', slug: 'history-post', content: '<p>Other</p>' },
      }),
      rootContext,
    );
    expect(otherBlog.status).toBe(201);

    const requestList = async (query = '') => {
      const response = await listRevisions(
        await authenticatedRequest(
          `http://localhost:3003/api/admin/blogs/history-post/revisions${query}`,
          { user: admin, siteId: site._id.toString() },
        ),
        slugContext('history-post'),
      );
      return { response, body: await response.json() };
    };

    const first = await requestList();
    expect(first.response.status).toBe(200);
    expect(first.body.meta).toEqual({ page: 1, limit: 20, total: 25, totalPages: 2 });
    expect(first.body.data).toHaveLength(20);
    expect(first.body.data[0].createdAt >= first.body.data[1].createdAt).toBe(true);
    expect(
      first.body.data.every((revision: Record<string, unknown>) => !('snapshot' in revision)),
    ).toBe(true);

    const second = await requestList('?page=2&limit=20');
    expect(second.response.status).toBe(200);
    expect(second.body.meta).toEqual({ page: 2, limit: 20, total: 25, totalPages: 2 });
    expect(second.body.data).toHaveLength(5);
    expect(second.body.data[0].createdAt >= second.body.data[1].createdAt).toBe(true);

    const custom = await requestList('?page=2&limit=5');
    expect(custom.response.status).toBe(200);
    expect(custom.body.meta).toEqual({ page: 2, limit: 5, total: 25, totalPages: 5 });
    expect(custom.body.data).toHaveLength(5);

    const beyond = await requestList('?page=3&limit=20');
    expect(beyond.response.status).toBe(200);
    expect(beyond.body).toMatchObject({
      data: [],
      meta: { page: 3, limit: 20, total: 25, totalPages: 2 },
    });

    const clientSuppliedSite = await requestList(`?siteId=${otherSite._id.toString()}`);
    expect(clientSuppliedSite.body.meta.total).toBe(25);
    expect(clientSuppliedSite.body.data).not.toContainEqual(
      expect.objectContaining({ blogId: otherBlog._id }),
    );

    for (const query of [
      '?page=0',
      '?page=-1',
      '?page=1.5',
      '?page=page',
      '?limit=0',
      '?limit=-1',
      '?limit=1.5',
      '?limit=limit',
      '?limit=101',
      '?page=9007199254740991&limit=100',
    ]) {
      const invalid = await requestList(query);
      expect(invalid.response.status).toBe(400);
    }
  });

  it('returns an empty, bounded history for a legacy blog without revisions', async () => {
    const admin = await createTestUser();
    const site = await createTestSite();
    await Blog.create({
      siteId: site._id,
      title: 'No history',
      slug: 'no-history',
      content: '<p>Source</p>',
      rendered: await renderBlogSnapshot('<p>Source</p>'),
      authorId: null,
      status: 'draft',
      createdBy: null,
      updatedBy: null,
    });
    const response = await listRevisions(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/no-history/revisions', {
        user: admin,
        siteId: site._id.toString(),
      }),
      slugContext('no-history'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('keeps the previous state recoverable through an A to B restoration round trip', async () => {
    const { admin, site, blog } = await createRevisionedBlog('publish');
    const publishedAt = blog.publishedAt;
    const initial = await BlogRevision.findOne({
      siteId: site._id,
      blogId: blog._id,
      action: 'created',
    })
      .lean()
      .exec();
    expect(initial).not.toBeNull();

    const updated = await updateBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/history-post', {
        user: admin,
        siteId: site._id.toString(),
        method: 'PUT',
        json: { title: 'Version B', content: '<h2>Version B</h2><p>Body B</p>' },
      }),
      slugContext('history-post'),
    );
    expect(updated.status).toBe(200);
    const versionB = await BlogRevision.findOne({
      siteId: site._id,
      blogId: blog._id,
      action: 'updated',
      'snapshot.title': 'Version B',
    })
      .lean()
      .exec();
    expect(versionB).not.toBeNull();

    const restoreA = await restoreRevision(
      await authenticatedRequest(
        `http://localhost:3003/api/admin/blogs/history-post/revisions/${initial!._id}/restore`,
        { user: admin, siteId: site._id.toString(), method: 'POST', json: {} },
      ),
      revisionContext('history-post', initial!._id.toString()),
    );
    expect(restoreA.status).toBe(200);
    const restoredA = await restoreA.json();
    expect(restoredA).toMatchObject({
      title: 'First title',
      slug: 'history-post',
      status: 'publish',
      publishedAt,
    });
    expect(restoredA.rendered.html).toContain('First heading');
    const restoredARevision = await BlogRevision.findOne({
      siteId: site._id,
      blogId: blog._id,
      action: 'restored',
      restoredFromRevisionId: initial!._id,
    })
      .lean()
      .exec();
    expect(restoredARevision?.snapshot.title).toBe('First title');
    expect(
      await BlogRevision.exists({ _id: versionB!._id, siteId: site._id, blogId: blog._id }),
    ).toBeTruthy();

    const restoreB = await restoreRevision(
      await authenticatedRequest(
        `http://localhost:3003/api/admin/blogs/history-post/revisions/${versionB!._id}/restore`,
        { user: admin, siteId: site._id.toString(), method: 'POST', json: {} },
      ),
      revisionContext('history-post', versionB!._id.toString()),
    );
    expect(restoreB.status).toBe(200);
    const restoredB = await restoreB.json();
    expect(restoredB).toMatchObject({
      title: 'Version B',
      slug: 'history-post',
      status: 'publish',
      publishedAt,
    });
    expect(restoredB.rendered.html).toContain('Version B');
  });

  it('removes only the deleted blog revisions, scoped to the active site', async () => {
    const { admin, site, blog } = await createRevisionedBlog();
    const otherBlogResponse = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user: admin,
        siteId: site._id.toString(),
        method: 'POST',
        json: {
          title: 'Another history',
          slug: 'another-history-post',
          content: '<p>Another</p>',
        },
      }),
      rootContext,
    );
    const otherBlog = await otherBlogResponse.json();
    const otherSite = await createTestSite();
    const foreign = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user: admin,
        siteId: otherSite._id.toString(),
        method: 'POST',
        json: { title: 'Foreign history', slug: 'history-post', content: '<p>Foreign</p>' },
      }),
      rootContext,
    );
    const foreignBlog = await foreign.json();
    expect(await BlogRevision.countDocuments({ siteId: site._id, blogId: blog._id })).toBe(1);

    const deleted = await deleteBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/history-post', {
        user: admin,
        siteId: site._id.toString(),
        method: 'DELETE',
        json: {},
      }),
      slugContext('history-post'),
    );
    expect(deleted.status).toBe(200);
    expect(await Blog.findOne({ _id: blog._id, siteId: site._id })).toBeNull();
    expect(await BlogRevision.countDocuments({ siteId: site._id, blogId: blog._id })).toBe(0);
    expect(await BlogRevision.countDocuments({ siteId: site._id, blogId: otherBlog._id })).toBe(1);
    expect(
      await BlogRevision.countDocuments({ siteId: otherSite._id, blogId: foreignBlog._id }),
    ).toBe(1);
  });

  it('rejects revision mutations and leaves their immutable snapshots unchanged', async () => {
    const { site, blog } = await createRevisionedBlog();
    const revision = await BlogRevision.findOne({ siteId: site._id, blogId: blog._id }).exec();
    expect(revision).not.toBeNull();
    await expect(
      BlogRevision.updateOne({ _id: revision!._id }, { $set: { 'snapshot.title': 'Tampered' } }),
    ).rejects.toThrow('Blog revisions are immutable');
    const reloaded = await BlogRevision.findById(revision!._id).lean().exec();
    expect(reloaded?.snapshot.title).toBe('First title');
  });

  it('rejects unusable restored authors without changing the blog or adding a revision', async () => {
    const { admin, site, blog } = await createRevisionedBlog('publish');
    const otherSite = await createTestSite();
    const draftAuthor = await Author.create({
      siteId: site._id,
      name: 'Draft author',
      slug: 'draft-author',
      status: 'draft',
      createdBy: admin._id,
      updatedBy: admin._id,
    });
    const foreignAuthor = await Author.create({
      siteId: otherSite._id,
      name: 'Foreign author',
      slug: 'foreign-author',
      status: 'publish',
      createdBy: admin._id,
      updatedBy: admin._id,
    });
    const deletedAuthor = await Author.create({
      siteId: site._id,
      name: 'Deleted author',
      slug: 'deleted-author',
      status: 'publish',
      createdBy: admin._id,
      updatedBy: admin._id,
    });
    await Author.deleteOne({ _id: deletedAuthor._id, siteId: site._id });

    for (const [label, authorId] of [
      ['draft', draftAuthor._id],
      ['foreign', foreignAuthor._id],
      ['deleted', deletedAuthor._id],
    ] as const) {
      const revision = await BlogRevision.create({
        siteId: site._id,
        blogId: blog._id,
        action: 'updated',
        createdBy: admin._id,
        restoredFromRevisionId: null,
        snapshot: { ...revisionSnapshot(`${label} author`), authorId },
      });
      const beforeCount = await BlogRevision.countDocuments({ siteId: site._id, blogId: blog._id });
      const restored = await restoreRevision(
        await authenticatedRequest(
          `http://localhost:3003/api/admin/blogs/history-post/revisions/${revision._id}/restore`,
          { user: admin, siteId: site._id.toString(), method: 'POST', json: {} },
        ),
        revisionContext('history-post', revision._id.toString()),
      );
      expect(restored.status).toBe(400);
      expect((await Blog.findById(blog._id).lean().exec())?.title).toBe('First title');
      expect(await BlogRevision.countDocuments({ siteId: site._id, blogId: blog._id })).toBe(
        beforeCount,
      );
    }
  });
});
