import { Router, type IRouter } from "express";
import healthRouter from "./health";
import conversionsRouter from "./conversions";
import cookiesRouter from "./cookies";
import archiveRouter from "./archive";
import settingsRouter from "./settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(conversionsRouter);
router.use(cookiesRouter);
router.use(archiveRouter);
router.use(settingsRouter);

export default router;
