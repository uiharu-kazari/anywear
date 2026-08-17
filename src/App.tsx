import { useStore } from './lib/store';
import Welcome from './components/Welcome';
import Studio from './components/Studio';

export default function App() {
  const twinPhoto = useStore((s) => s.twinPhoto);
  return twinPhoto ? <Studio /> : <Welcome />;
}
