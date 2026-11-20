import { useState } from "react";
import { Box, FileCode2, FolderTree, SlidersHorizontal } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Thread } from "./thread";

const GATES = [
  { id: "dims", title: "Dimensions", detail: "Bounding box 82.0 × 40.0 × 24.0 mm, within 0.2 mm of the spec." },
  { id: "manifold", title: "Manifold", detail: "One closed solid, no open edges." },
  { id: "walls", title: "Wall thickness", detail: "Thinnest wall 1.6 mm at the clip root; the spec asks for 1.2 mm." },
];

function AppMenubar({ open }: { open: boolean }) {
  const [grid, setGrid] = useState(true);
  const [view, setView] = useState("iso");
  return (
    <Menubar defaultValue={open ? "view" : undefined}>
      <MenubarMenu value="part">
        <MenubarTrigger>Part</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>
            Re-evaluate <MenubarShortcut>⌘R</MenubarShortcut>
          </MenubarItem>
          <MenubarItem>Download STL</MenubarItem>
          <MenubarSeparator />
          <MenubarItem variant="destructive">Delete part</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu value="view">
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          <MenubarCheckboxItem checked={grid} onCheckedChange={setGrid}>
            Ground grid
          </MenubarCheckboxItem>
          <MenubarSeparator />
          <MenubarRadioGroup value={view} onValueChange={setView}>
            <MenubarRadioItem value="iso">Isometric</MenubarRadioItem>
            <MenubarRadioItem value="top">Top</MenubarRadioItem>
            <MenubarRadioItem value="front">Front</MenubarRadioItem>
          </MenubarRadioGroup>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu value="session">
        <MenubarTrigger>Session</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>New session</MenubarItem>
          <MenubarItem>Stop agent</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}

function ParamsPopover({ open }: { open: boolean }) {
  return (
    <Popover defaultOpen={open}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <SlidersHorizontal />
          Parameters
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>wall</PopoverTitle>
          <PopoverDescription>Wall thickness in mm. The agent re-renders when you change it.</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}

function Pane({ icon: Icon, title, children }: { icon: typeof Box; title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs font-medium text-dim">
        <Icon className="size-3.5" />
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

export function Gallery({ open }: { open: string | null }) {
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-card px-3">
        <AppMenubar open={open === "menu"} />
        <div className="ml-auto">
          <ParamsPopover open={open === "popover"} />
        </div>
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="18%" minSize="12%">
          <Pane icon={FolderTree} title="Files">
            <ul className="space-y-1 p-3 text-sm text-dim">
              <li>parts/clip.scad</li>
              <li>parts/tray.scad</li>
              <li>notes/brief.md</li>
            </ul>
          </Pane>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="44%" minSize="25%">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel defaultSize="55%">
              <Pane icon={Box} title="clip">
                <div className="grid h-full place-items-center text-sm text-faint">3D viewer</div>
              </Pane>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="45%">
              <Pane icon={FileCode2} title="Gates">
                <Accordion type="single" collapsible defaultValue="walls" className="px-3">
                  {GATES.map((g) => (
                    <AccordionItem key={g.id} value={g.id}>
                      <AccordionTrigger>{g.title}</AccordionTrigger>
                      <AccordionContent className="text-dim">{g.detail}</AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </Pane>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="38%" minSize="25%">
          <Thread />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
