'use server';

import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { formSchema, type FormValues } from '@/lib/validations';
import { convertAmountToMinorUnits } from '@/lib/utils';
import { eq, desc, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

// --- Auth Handling ---
// 実運用の際はここをClerkやAuth.jsのロジックに置き換える
async function getCurrentUser() {
  return { id: 'user_demo_123' };
}
// --------------------

export type ActionResponse<T = null> = {
  success: boolean;
  data?: T;
  error?: string;
  fieldErrors?: Record<string, string[]>; // Zodのフィールドエラー用
};

// フロントエンド公開用データ型
export type SubscriptionPublic = Omit<typeof subscriptions.$inferSelect, 'userId' | 'createdAt' | 'updatedAt'>;

export async function getSubscriptions(): Promise<ActionResponse<SubscriptionPublic[]>> {
  try {
    const user = await getCurrentUser();
    
    // 型安全性を確保しつつ、必要なカラムのみ取得
    const data = await db.query.subscriptions.findMany({
      where: eq(subscriptions.userId, user.id),
      orderBy: [desc(subscriptions.nextPayment)],
      columns: {
        id: true,
        name: true,
        price: true,
        currency: true,
        cycle: true,
        nextPayment: true,
        category: true,
        isActive: true,
      }
    });
    return { success: true, data: data as SubscriptionPublic[] };
  } catch (error) {
    console.error('Failed to fetch subscriptions:', error);
    return { success: false, error: 'データの取得に失敗しました', data: [] };
  }
}

export async function addSubscription(data: FormValues): Promise<ActionResponse> {
  const validated = formSchema.safeParse(data);
  if (!validated.success) {
    return { 
      success: false, 
      error: '入力内容を確認してください',
      fieldErrors: validated.error.flatten().fieldErrors 
    };
  }

  try {
    const user = await getCurrentUser();
    
    // UIの数値(小数)をDB用整数に変換 (v1.1で修正済みの安全な関数を使用)
    const priceInMinorUnits = convertAmountToMinorUnits(
      validated.data.price, 
      validated.data.currency
    );

    await db.insert(subscriptions).values({
      ...validated.data,
      price: priceInMinorUnits,
      userId: user.id,
      updatedAt: new Date(),
    });

    // サーバー側でパスを固定してRevalidate
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('[Action:addSubscription] Error:', error);
    
    if (error instanceof Error && error.message.includes('unique constraint')) {
       return { success: false, error: '重複したデータが存在します' };
    }

    return { success: false, error: 'データベースへの保存に失敗しました' };
  }
}

export async function deleteSubscription(id: string): Promise<ActionResponse> {
  try {
    const user = await getCurrentUser();

    // userIdを条件に含めることで、所有者のみが削除可能
    const result = await db.delete(subscriptions)
      .where(
        and(
          eq(subscriptions.id, id),
          eq(subscriptions.userId, user.id)
        )
      )
      .returning({ deletedId: subscriptions.id });

    if (result.length === 0) {
      return { success: false, error: '削除対象が見つからないか、権限がありません' };
    }
    
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('[Action:deleteSubscription] Error:', error);
    return { success: false, error: '削除処理中にエラーが発生しました' };
  }
}
