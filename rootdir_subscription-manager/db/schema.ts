import { pgTable, text, integer, boolean, timestamp, uuid, date, index } from 'drizzle-orm/pg-core';
import { type InferSelectModel, type InferInsertModel } from 'drizzle-orm';
import { SUBSCRIPTION_CYCLES, CURRENCIES } from '@/lib/constants';

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  
  name: text('name').notNull(),
  // integerだが、通貨の最小単位(cents/yen)で保存する
  price: integer('price').notNull(), 
  currency: text('currency').default(CURRENCIES.JPY.code).notNull(),
  
  cycle: text('cycle', { enum: [SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly] }).notNull(),
  nextPayment: date('next_payment').notNull(),
  
  category: text('category').default('general'),
  isActive: boolean('is_active').default(true).notNull(),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(), 
}, (table) => {
  return {
    userIdIdx: index('user_id_idx').on(table.userId),
  };
});

export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;
