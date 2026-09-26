import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createBlog } from '@/app/api/admin/blogs/route';
import { PUT as updateBlog } from '@/app/api/admin/blogs/[slug]/route';
import { GET as listRevisions } from '@/app/api/admin/blogs/[slug]/revisions/route';
import { GET as getRevision } from '@/app/api/admin/blogs/[slug]/revisions/[revisionId]/route';
import { POST as restoreRevision } from '@/app/api/admin/blogs/[slug]/revisions/[revisionId]/restore/route';
import { renderBlogSnapshot } from '@/lib/render/blog';
import Blog from '@/models/Blog';
import BlogRevision from '@/models/BlogRevision';
import { authenticatedRequest, createTestSite, createTestUser } from '@/tests/setup/factories';

const rootContext = { params: Promise.resolve({}) };
const slugContext = (slug: string) => ({ params: Promise.resolve({ slug }) });
const revisionContext = (slug: string, revisionId: string) => ({
  params: Promise.resolve({ slug, revisionId }),
});

async function createRevisionedBlog(status: 'draft' | 'publish' = 'draft') {
  const admin = await createTestUser();
  const site = await createTestSite();
  const response = await createBlog(
    await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
      user: admin,
      siteId: site._id.toString(),
      method: 'POST',
      json: {
        title: 'First title',
        slug: 'history-post',
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
    expect(listed).toHaveLength(2);
    expect(listed[0].createdAt >= listed[1].createdAt).toBe(true);
    expect(listed[0]).not.toHaveProperty('snapshot');

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
});
