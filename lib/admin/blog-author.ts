import { validationError } from '@/lib/http/errors';
import type { PublicationStatus } from '@/models/Blog';
import Author from '@/models/Author';
import type { ClientSession } from 'mongoose';

export async function assertBlogAuthorIsUsable({
  authorId,
  siteId,
  blogStatus,
  session,
}: {
  authorId: string | null | undefined;
  siteId: string;
  blogStatus: PublicationStatus;
  session?: ClientSession;
}): Promise<void> {
  if (!authorId) return;

  const author = await Author.findOne({ _id: authorId, siteId })
    .select('status')
    .session(session ?? null)
    .lean()
    .exec();
  if (!author) {
    throw validationError(
      { fieldErrors: { authorId: ['Author must belong to the selected site'] } },
      'Invalid blog payload',
    );
  }
  if (blogStatus === 'publish' && author.status !== 'publish') {
    throw validationError(
      { fieldErrors: { authorId: ['Author must be published before the blog'] } },
      'Invalid blog payload',
    );
  }
}
