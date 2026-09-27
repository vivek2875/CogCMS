import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifySiteWebhook = vi.hoisted(() => vi.fn());
vi.mock('@/lib/webhook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhook')>()),
  notifySiteWebhook,
}));

import { POST as createBlog } from '@/app/api/admin/blogs/route';
import { DELETE as deleteBlog, PUT as updateBlog } from '@/app/api/admin/blogs/[slug]/route';
import { POST as restoreRevision } from '@/app/api/admin/blogs/[slug]/revisions/[revisionId]/restore/route';
import BlogRevision from '@/models/BlogRevision';
import { authenticatedRequest, createTestSite, createTestUser } from '@/tests/setup/factories';

const rootContext = { params: Promise.resolve({}) };
const payload = {
  title: 'Webhook post',
  slug: 'webhook-post',
  content: '<p>Body</p>',
  status: 'publish' as const,
};

describe('blog webhook events', () => {
  beforeEach(() => notifySiteWebhook.mockReset());

  it('dispatches publish, update, unpublish, and public delete transitions', async () => {
    const site = await createTestSite();
    const user = await createTestUser({ siteIds: [site._id.toString()] });
    const created = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user,
        siteId: site._id.toString(),
        method: 'POST',
        json: payload,
      }),
      rootContext,
    );
    const body = await created.json();
    expect(notifySiteWebhook).toHaveBeenLastCalledWith(
      site._id.toString(),
      expect.objectContaining({
        type: 'content.published',
        contentType: 'post',
        slug: 'webhook-post',
        id: body._id,
      }),
    );

    const context = { params: Promise.resolve({ slug: 'webhook-post' }) };
    await updateBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/webhook-post', {
        user,
        siteId: site._id.toString(),
        method: 'PUT',
        json: { title: 'Updated' },
      }),
      context,
    );
    expect(notifySiteWebhook).toHaveBeenLastCalledWith(
      site._id.toString(),
      expect.objectContaining({ type: 'content.updated' }),
    );

    await updateBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/webhook-post', {
        user,
        siteId: site._id.toString(),
        method: 'PUT',
        json: { status: 'draft' },
      }),
      context,
    );
    expect(notifySiteWebhook).toHaveBeenLastCalledWith(
      site._id.toString(),
      expect.objectContaining({ type: 'content.unpublished' }),
    );

    await updateBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/webhook-post', {
        user,
        siteId: site._id.toString(),
        method: 'PUT',
        json: { status: 'publish' },
      }),
      context,
    );
    await deleteBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/webhook-post', {
        user,
        siteId: site._id.toString(),
        method: 'DELETE',
        json: {},
      }),
      context,
    );
    expect(notifySiteWebhook).toHaveBeenLastCalledWith(
      site._id.toString(),
      expect.objectContaining({ type: 'content.deleted' }),
    );
  });

  it('notifies connected sites once after restoring published content', async () => {
    const site = await createTestSite();
    const user = await createTestUser({ siteIds: [site._id.toString()] });
    const created = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user,
        siteId: site._id.toString(),
        method: 'POST',
        json: payload,
      }),
      rootContext,
    );
    const blog = await created.json();
    const revision = await BlogRevision.findOne({ siteId: site._id, blogId: blog._id })
      .lean()
      .exec();
    notifySiteWebhook.mockReset();

    const restored = await restoreRevision(
      await authenticatedRequest(
        `http://localhost:3003/api/admin/blogs/webhook-post/revisions/${revision!._id}/restore`,
        { user, siteId: site._id.toString(), method: 'POST', json: {} },
      ),
      { params: Promise.resolve({ slug: 'webhook-post', revisionId: revision!._id.toString() }) },
    );
    expect(restored.status).toBe(200);
    expect(notifySiteWebhook).toHaveBeenCalledTimes(1);
    expect(notifySiteWebhook).toHaveBeenCalledWith(
      site._id.toString(),
      expect.objectContaining({
        type: 'content.updated',
        contentType: 'post',
        slug: 'webhook-post',
        id: blog._id,
      }),
    );
  });

  it('does not notify public webhooks for draft or failed restorations', async () => {
    const site = await createTestSite();
    const user = await createTestUser({ siteIds: [site._id.toString()] });
    const created = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user,
        siteId: site._id.toString(),
        method: 'POST',
        json: { ...payload, status: 'draft' as const },
      }),
      rootContext,
    );
    const blog = await created.json();
    const revision = await BlogRevision.findOne({ siteId: site._id, blogId: blog._id })
      .lean()
      .exec();
    notifySiteWebhook.mockReset();

    const restoredDraft = await restoreRevision(
      await authenticatedRequest(
        `http://localhost:3003/api/admin/blogs/webhook-post/revisions/${revision!._id}/restore`,
        { user, siteId: site._id.toString(), method: 'POST', json: {} },
      ),
      { params: Promise.resolve({ slug: 'webhook-post', revisionId: revision!._id.toString() }) },
    );
    expect(restoredDraft.status).toBe(200);
    expect(notifySiteWebhook).not.toHaveBeenCalled();

    const failed = await restoreRevision(
      await authenticatedRequest(
        'http://localhost:3003/api/admin/blogs/webhook-post/revisions/not-an-id/restore',
        { user, siteId: site._id.toString(), method: 'POST', json: {} },
      ),
      { params: Promise.resolve({ slug: 'webhook-post', revisionId: 'not-an-id' }) },
    );
    expect(failed.status).toBe(400);
    expect(notifySiteWebhook).not.toHaveBeenCalled();
  });

  it('keeps existing public deletion notifications and skips draft deletion notifications', async () => {
    const site = await createTestSite();
    const user = await createTestUser({ siteIds: [site._id.toString()] });
    const published = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user,
        siteId: site._id.toString(),
        method: 'POST',
        json: { ...payload, slug: 'published-delete' },
      }),
      rootContext,
    );
    const publishedBlog = await published.json();
    notifySiteWebhook.mockReset();
    const publishedDelete = await deleteBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/published-delete', {
        user,
        siteId: site._id.toString(),
        method: 'DELETE',
        json: {},
      }),
      { params: Promise.resolve({ slug: 'published-delete' }) },
    );
    expect(publishedDelete.status).toBe(200);
    expect(notifySiteWebhook).toHaveBeenCalledWith(
      site._id.toString(),
      expect.objectContaining({ type: 'content.deleted', id: publishedBlog._id }),
    );

    const draft = await createBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs', {
        user,
        siteId: site._id.toString(),
        method: 'POST',
        json: { ...payload, slug: 'draft-delete', status: 'draft' as const },
      }),
      rootContext,
    );
    expect(draft.status).toBe(201);
    notifySiteWebhook.mockReset();
    const draftDelete = await deleteBlog(
      await authenticatedRequest('http://localhost:3003/api/admin/blogs/draft-delete', {
        user,
        siteId: site._id.toString(),
        method: 'DELETE',
        json: {},
      }),
      { params: Promise.resolve({ slug: 'draft-delete' }) },
    );
    expect(draftDelete.status).toBe(200);
    expect(notifySiteWebhook).not.toHaveBeenCalled();
  });
});
