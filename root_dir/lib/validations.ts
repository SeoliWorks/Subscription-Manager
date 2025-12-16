import { z } from 'zod';
import { SUBSCRIPTION_CYCLES, CURRENCIES } from '@/lib/constants';

export const formSchema = z.object({
  name: z.string().min(1, 'サービス名は必須です'),
  price: z.coerce.number()
    .min(0.01, '金額を入力してください')
    .nonnegative('マイナスの金額は入力できません'),
  currency: z.enum([CURRENCIES.JPY.code, CURRENCIES.USD.code, CURRENCIES.EUR.code]),
  cycle: z.enum([SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly], {
    required_error: '支払いサイクルを選択してください',
  }),
  nextPayment: z.string().date().refine((val) => {
    const date = new Date(val);
    return !isNaN(date.getTime()) && date.getFullYear() > 2000;
  }, '正しい日付を入力してください'),
  category: z.string().optional(),
});

export type FormValues = z.infer<typeof formSchema>;
