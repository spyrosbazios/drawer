import { Agents } from "@/components/Agents";
import { Footer } from "@/components/Footer";
import { GetStarted } from "@/components/GetStarted";
import { Hero } from "@/components/Hero";
import { Idea } from "@/components/Idea";
import { Imports } from "@/components/Imports";
import { Nav } from "@/components/Nav";
import { SelfHost } from "@/components/SelfHost";
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
        <Showcase />
        <Agents />
        <Imports />
        <SelfHost />
        <GetStarted />
      </main>
      <Footer />
    </>
  );
}
