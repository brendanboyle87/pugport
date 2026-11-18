export type DigestItem = {
  id: string;
  source: 'slack' | 'github';
  text: string;
  group: string;
  permalink?: string;
  workflowId?: string;
  status?: 'pending' | 'approved' | 'rejected';
};
export type ExternalDigest = {
  day: string;
  pending: DigestItem[];
  done: DigestItem[];
  noted: DigestItem[];
  remaining: number;
};
export type DigestSettings = { time: string; destination: 'pugport' | 'pugport-slack' };
