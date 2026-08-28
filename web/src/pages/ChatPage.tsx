import { PageHeader, Empty } from '../components/ui';

export default function ChatPage(): React.ReactNode {
  return (
    <div>
      <PageHeader title="Master Chat" />
      <Empty>chat — next milestone</Empty>
    </div>
  );
}
