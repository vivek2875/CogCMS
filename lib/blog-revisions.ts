import type { ClientSession, Types } from 'mongoose';
import type { IBlog } from '@/models/Blog';
import BlogRevision, {
  type BlogRevisionAction,
  type BlogRevisionSnapshot,
  type IBlogRevision,
} from '@/models/BlogRevision';

/**
 * Revision snapshots intentionally contain editorial inputs only. Rendered output,
 * publication state, identity, and audit fields remain properties of the live blog.
 */
export function snapshotBlog(blog: IBlog): BlogRevisionSnapshot {
  return {
    title: blog.title,
    excerpt: blog.excerpt ?? '',
    content: blog.content,
    imageUrl: blog.imageUrl ?? '',
    tag: blog.tag ?? 'Insights',
    authorId: blog.authorId ?? null,
    category: blog.category ?? '',
    tags: [...(blog.tags ?? [])],
    faqs: (blog.faqs ?? []).map((faq) => ({ question: faq.question, answer: faq.answer })),
    keyTakeaways: [...(blog.keyTakeaways ?? [])],
    relatedSlugs: [...(blog.relatedSlugs ?? [])],
    tocOverrides: (blog.tocOverrides ?? []).map((toc) => ({
      id: toc.id,
      ...(toc.label === undefined ? {} : { label: toc.label }),
      ...(toc.hidden === undefined ? {} : { hidden: toc.hidden }),
    })),
    metaTitle: blog.metaTitle ?? '',
    metaDescription: blog.metaDescription ?? '',
    keywords: blog.keywords ?? '',
    isFeatured: blog.isFeatured ?? false,
  };
}

export async function createBlogRevision({
  siteId,
  blog,
  action,
  createdBy,
  restoredFromRevisionId = null,
  session,
}: {
  siteId: string | Types.ObjectId;
  blog: IBlog;
  action: BlogRevisionAction;
  createdBy: string | Types.ObjectId | null;
  restoredFromRevisionId?: string | Types.ObjectId | null;
  session: ClientSession;
}): Promise<IBlogRevision> {
  const [revision] = await BlogRevision.create(
    [
      {
        siteId,
        blogId: blog._id,
        snapshot: snapshotBlog(blog),
        action,
        createdBy,
        restoredFromRevisionId,
      },
    ],
    { session },
  );
  return revision;
}

export function isRevisionId(value: string): boolean {
  return /^[a-f\d]{24}$/i.test(value);
}
