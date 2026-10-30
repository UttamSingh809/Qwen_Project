// Projects, memberships and invitations. All access enforced server-side.

import { Router } from 'express';
import { ActivityType, Prisma, ProjectRole } from '@prisma/client';
import { prisma } from '../db';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import {
  createProjectSchema,
  inviteSchema,
  memberRoleSchema,
  updateProjectSchema,
} from '../lib/validation';
import { requireAuth, loadProjectAccess, requireRole } from '../middleware/auth';
import { PROJECT_SORT_FIELDS, paginationMeta, parsePagination } from '../lib/businessRules';

const INVITATION_TTL_DAYS = 14;

const projectShape = (p: any) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  archived: p.archived,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  ownerId: p.ownerId,
  owner: p.owner ? { id: p.owner.id, name: p.owner.name, email: p.owner.email } : undefined,
  myRole: p.myRole ?? null,
  memberCount: p._count?.members ?? p.memberCount ?? undefined,
  taskCount: p._count?.tasks ?? p.taskCount ?? undefined,
});

export function createProjectsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // ---------------------------------------------------------------- list mine
  router.get('/', asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query.page, req.query.pageSize);
    const sortRaw = String(req.query.sort ?? 'updatedAt');
    if (!PROJECT_SORT_FIELDS.includes(sortRaw as any)) throw badRequest('Invalid sort field');
    const order = req.query.order === 'asc' ? 'asc' : 'desc';

    const where: Prisma.ProjectWhereInput = {
      OR: [
        { ownerId: req.user!.id },
        { members: { some: { userId: req.user!.id } } },
      ],
      ...(req.query.archived === 'true' ? { archived: true } : {}),
      ...(typeof req.query.q === 'string' && req.query.q ? { name: { contains: req.query.q as string, mode: 'insensitive' } } : {}),
    };
    const [total, projects] = await prisma.$transaction([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        orderBy: [{ [sortRaw]: order }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          owner: { select: { id: true, name: true, email: true } },
          _count: { select: { members: true, tasks: true } },
          members: { where: { userId: req.user!.id }, select: { role: true } },
        },
      }),
    ]);
    res.json({
      data: projects.map((p) => projectShape({ ...p, myRole: p.members[0]?.role ?? (p.ownerId === req.user!.id ? ProjectRole.OWNER : null) })),
      meta: paginationMeta(total, page, pageSize),
    });
  }));

  // ------------------------------------------------------------------- create
  router.post('/', asyncHandler(async (req, res) => {
    const data = createProjectSchema.parse(req.body);
    const project = await prisma.project.create({
      data: {
        name: data.name,
        description: data.description,
        ownerId: req.user!.id,
        members: { create: { userId: req.user!.id, role: ProjectRole.OWNER } },
        activities: {
          create: {
            type: ActivityType.PROJECT_CREATED,
            actorId: req.user!.id,
            actorName: req.user!.email,
            message: `created project "${data.name}"`,
          },
        },
      },
      include: { owner: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json({ project: projectShape({ ...project, myRole: ProjectRole.OWNER }) });
  }));

  // ------------------------------------------------- per-project scoped routes
  router.use('/:projectId', loadProjectAccess);

  // read: any role (including OWNER via loadProjectAccess); non-members get 403
  router.get('/:projectId', requireRole(ProjectRole.VIEWER), asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, tasks: true } },
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!project) throw notFound('Project not found');
    res.json({
      project: {
        ...projectShape({ ...project, myRole: req.projectAccess!.role }),
        members: project.members.map((m) => ({
          id: m.id,
          role: m.role,
          userId: m.user.id,
          user: m.user,
          createdAt: m.createdAt,
        })),
      },
    });
  }));

  // write: ADMIN+
  router.patch('/:projectId', requireRole(ProjectRole.ADMIN), asyncHandler(async (req, res) => {
    const data = updateProjectSchema.parse(req.body);
    const project = await prisma.project.update({
      where: { id: req.params.projectId },
      data,
      include: { owner: { select: { id: true, name: true, email: true } } },
    });
    await prisma.activityLog.create({
      data: {
        projectId: project.id,
        type: ActivityType.PROJECT_UPDATED,
        actorId: req.user!.id,
        actorName: req.user!.email,
        message: `updated project "${project.name}"`,
        metadata: data as object,
      },
    });
    res.json({ project: projectShape({ ...project, myRole: req.projectAccess!.role }) });
  }));

  // delete: OWNER only (destructive)
  router.delete('/:projectId', requireRole(ProjectRole.OWNER), asyncHandler(async (req, res) => {
    await prisma.project.delete({ where: { id: req.params.projectId } });
    res.status(204).send();
  }));

  // ------------------------------------------------------------- members list
  router.get('/:projectId/members', requireRole(ProjectRole.VIEWER), asyncHandler(async (req, res) => {
    const members = await prisma.projectMember.findMany({
      where: { projectId: req.params.projectId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: members.map((m) => ({ id: m.id, role: m.role, userId: m.user.id, user: m.user, createdAt: m.createdAt })) });
  }));

  // change member role: OWNER+ ; cannot change own/owner row through this endpoint
  router.patch('/:projectId/members/:memberId', requireRole(ProjectRole.OWNER), asyncHandler(async (req, res) => {
    const { role } = memberRoleSchema.parse(req.body);
    const member = await prisma.projectMember.findFirst({
      where: { id: req.params.memberId, projectId: req.params.projectId },
    });
    if (!member) throw notFound('Member not found');
    const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
    if (member.userId === project?.ownerId) throw badRequest('Cannot change the owner role; transfer ownership instead');
    const updated = await prisma.projectMember.update({ where: { id: member.id }, data: { role } });
    await prisma.activityLog.create({
      data: {
        projectId: member.projectId,
        type: ActivityType.MEMBER_ROLE_CHANGED,
        actorId: req.user!.id,
        actorName: req.user!.email,
        message: `changed a member role to ${role}`,
        metadata: { memberId: member.id, role },
      },
    });
    res.json({ member: { id: updated.id, role: updated.role, userId: updated.userId } });
  }));

  // remove member: ADMIN+ ; admins cannot remove owners or other admins unless owner
  router.delete('/:projectId/members/:memberId', requireRole(ProjectRole.ADMIN), asyncHandler(async (req, res) => {
    const member = await prisma.projectMember.findFirst({
      where: { id: req.params.memberId, projectId: req.params.projectId },
    });
    if (!member) throw notFound('Member not found');
    const access = req.projectAccess!;
    if (member.role === ProjectRole.OWNER) throw badRequest('Cannot remove the project owner');
    if (member.role === ProjectRole.ADMIN && access.role !== ProjectRole.OWNER) throw forbidden('Only the owner can remove admins');
    if (member.userId === req.user!.id && access.role !== ProjectRole.OWNER) {
      // self-leave is allowed for anyone except the owner
      await prisma.projectMember.delete({ where: { id: member.id } });
    } else {
      await prisma.projectMember.delete({ where: { id: member.id } });
    }
    await prisma.activityLog.create({
      data: {
        projectId: member.projectId,
        type: ActivityType.MEMBER_REMOVED,
        actorId: req.user!.id,
        actorName: req.user!.email,
        message: `removed member ${member.userId}`,
        metadata: { memberId: member.id },
      },
    });
    res.status(204).send();
  }));

  // -------------------------------------------------------------- invitations
  router.post('/:projectId/invitations', requireRole(ProjectRole.ADMIN), asyncHandler(async (req, res) => {
    const data = inviteSchema.parse(req.body);
    const projectId = req.params.projectId!;

    const existingMember = await prisma.projectMember.findFirst({
      where: { projectId, user: { email: data.email } },
    });
    if (existingMember) throw conflict('This user is already a member of the project');

    try {
      const invitation = await prisma.invitation.create({
        data: {
          projectId,
          email: data.email,
          role: data.role,
          invitedById: req.user!.id,
          expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
        },
      });
      await prisma.activityLog.create({
        data: {
          projectId,
          type: ActivityType.MEMBER_INVITED,
          actorId: req.user!.id,
          actorName: req.user!.email,
          message: `invited ${data.email} as ${data.role}`,
          metadata: { invitationId: invitation.id },
        },
      });
      res.status(201).json({ invitation });
    } catch (err) {
      // Partial unique index violation: pending invitation already exists.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('A pending invitation already exists for this email');
      }
      throw err;
    }
  }));

  router.get('/:projectId/invitations', requireRole(ProjectRole.ADMIN), asyncHandler(async (req, res) => {
    const invitations = await prisma.invitation.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: invitations });
  }));

  router.delete('/:projectId/invitations/:invitationId', requireRole(ProjectRole.ADMIN), asyncHandler(async (req, res) => {
    const inv = await prisma.invitation.findFirst({
      where: { id: req.params.invitationId, projectId: req.params.projectId, status: 'PENDING' },
    });
    if (!inv) throw notFound('Pending invitation not found');
    await prisma.invitation.update({ where: { id: inv.id }, data: { status: 'CANCELLED' } });
    res.status(204).send();
  }));

  return router;
}

// ---------------------------------------------------------------------------
// Invitation accept/decline — user-scoped (not project-scoped) so a non-member
// can act on invitations addressed to their email.
// ---------------------------------------------------------------------------

export function createInvitationsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/my-invitations', asyncHandler(async (req, res) => {
    const invitations = await prisma.invitation.findMany({
      where: { email: req.user!.email, status: 'PENDING', expiresAt: { gt: new Date() } },
      include: { project: { select: { id: true, name: true } }, invitedBy: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: invitations });
  }));

  router.post('/:invitationId/accept', asyncHandler(async (req, res) => {
    const invitation = await prisma.invitation.findUnique({ where: { id: req.params.invitationId } });
    if (!invitation) throw notFound('Invitation not found');
    if (invitation.email !== req.user!.email) throw forbidden('This invitation is not addressed to you');
    if (invitation.status !== 'PENDING') throw badRequest(`Invitation is ${invitation.status.toLowerCase()}`);
    if (invitation.expiresAt.getTime() <= Date.now()) throw badRequest('Invitation has expired');

    // Transaction keeps membership + invitation state consistent.
    const result = await prisma.$transaction(async (tx) => {
      const reloaded = await tx.invitation.findUnique({ where: { id: invitation.id } });
      if (!reloaded || reloaded.status !== 'PENDING') throw conflict('Invitation was already handled');
      try {
        await tx.projectMember.create({
          data: { projectId: reloaded.projectId, userId: req.user!.id, role: reloaded.role },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw conflict('You are already a member of this project');
        }
        throw err;
      }
      const accepted = await tx.invitation.update({
        where: { id: reloaded.id },
        data: { status: 'ACCEPTED', acceptedUserId: req.user!.id },
      });
      await tx.activityLog.create({
        data: {
          projectId: reloaded.projectId,
          type: ActivityType.MEMBER_JOINED,
          actorId: req.user!.id,
          actorName: req.user!.email,
          message: `joined the project as ${reloaded.role}`,
          metadata: { invitationId: reloaded.id },
        },
      });
      return accepted;
    });
    res.json({ invitation: result });
  }));

  router.post('/:invitationId/decline', asyncHandler(async (req, res) => {
    const invitation = await prisma.invitation.findUnique({ where: { id: req.params.invitationId } });
    if (!invitation) throw notFound('Invitation not found');
    if (invitation.email !== req.user!.email) throw forbidden('This invitation is not addressed to you');
    if (invitation.status !== 'PENDING') throw badRequest(`Invitation is ${invitation.status.toLowerCase()}`);
    const declined = await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'DECLINED' },
    });
    await prisma.activityLog.create({
      data: {
        projectId: invitation.projectId,
        type: ActivityType.MEMBER_DECLINED,
        actorId: req.user!.id,
        actorName: req.user!.email,
        message: `declined an invitation`,
        metadata: { invitationId: invitation.id },
      },
    });
    res.json({ invitation: declined });
  }));

  return router;
}
