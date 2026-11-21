import { Agents } from "@/components/Agents";
import { Closing } from "@/components/Closing";
import { Features } from "@/components/Features";
import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { Idea } from "@/components/Idea";
import { Nav } from "@/components/Nav";
import { Showcase } from "@/components/Showcase";

export function App() {
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Idea />
        <Features />
        <Showcase />
        <Agents />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
