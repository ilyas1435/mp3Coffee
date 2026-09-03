import { AlertCircle, Home } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <div className="text-center p-8 md:p-12 bg-card rounded-[2rem] border border-border/50 shadow-2xl shadow-black/5 max-w-md w-full">
        <div className="w-20 h-20 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <AlertCircle className="w-10 h-10 text-destructive" />
        </div>
        <h1 className="text-4xl font-display font-bold text-foreground mb-3 tracking-tight">404</h1>
        <p className="text-muted-foreground mb-8 text-lg">The page you are looking for doesn't exist or has been moved.</p>
        <Link href="/" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-primary text-primary-foreground font-bold hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20 hover:-translate-y-0.5 transition-all w-full sm:w-auto">
          <Home className="w-5 h-5" />
          Go Back Home
        </Link>
      </div>
    </div>
  );
}
