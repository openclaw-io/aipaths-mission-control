import RuntimeClient from "@/components/runtime/RuntimeClient";

export default function RuntimePage() {
  return (
    <div>
      <h1 className="text-3xl font-bold text-white">🧭 Runtime</h1>
      <p className="mt-2 text-gray-400">
        Qué está corriendo en la Mac Mini AIPaths: servicios, puertos, URLs, health y LaunchAgents.
      </p>
      <RuntimeClient />
    </div>
  );
}
