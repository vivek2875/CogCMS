import type { Model } from 'mongoose';
import Author from '@/models/Author';
import ApiKey from '@/models/ApiKey';
import Blog from '@/models/Blog';
import BlogRevision from '@/models/BlogRevision';
import FAQ from '@/models/FAQ';
import FAQSubmission from '@/models/FAQSubmission';
import LoginAttempt from '@/models/LoginAttempt';
import IntakeRateLimit from '@/models/IntakeRateLimit';
import NewsletterSubscriber from '@/models/NewsletterSubscriber';
import ReleaseNote from '@/models/ReleaseNote';
import Site from '@/models/Site';
import User from '@/models/User';
import Whitepaper from '@/models/Whitepaper';

export const modelRegistry: Model<any>[] = [
  Site,
  User,
  LoginAttempt,
  Blog,
  BlogRevision,
  Author,
  FAQ,
  FAQSubmission,
  Whitepaper,
  NewsletterSubscriber,
  ReleaseNote,
  ApiKey,
  IntakeRateLimit,
];
